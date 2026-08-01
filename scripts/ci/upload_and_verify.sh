#!/usr/bin/env bash
# Robust concurrent S3 upload + verification script for CI
# - Uploads files to an S3/S3-compatible bucket
# - Verifies each object via head-object until ContentLength matches local size
# - Supports parallel uploads
# - Retries failures with backoff
# - Optional mock mode to test without real AWS (set MOCK_AWS=1)
#
# Usage:
#   upload_and_verify.sh --bucket BUCKET [--prefix PREFIX] [--endpoint-url URL]
#                        [--region REGION] [--concurrency N]
#                        [--retries N] [--retry-wait SECONDS]
#                        [--verify-attempts N] [--verify-wait SECONDS]
#                        [--dry-run] [--fail-on-missing]
#                        FILE [FILE ...]
#
# Examples:
#   # Upload all dist files with verification
#   ./upload_and_verify.sh --bucket mybucket --prefix releasesinternal dist/*.zip dist/*.dmg
#
#   # Mocked test with dummy files
#   MOCK_AWS=1 ./upload_and_verify.sh --bucket demo --prefix demo dist/*.zip
#
# Exit codes:
#   0 on full success; non-zero if any upload failed or verification failed.

set -euo pipefail

# Defaults
BUCKET=""
PREFIX=""
ENDPOINT_URL="${AWS_ENDPOINT_URL:-}"
REGION="${AWS_REGION:-}"
CONCURRENCY=0   # 0 means "auto"
RETRIES=4
RETRY_WAIT=10
VERIFY_ATTEMPTS=24
VERIFY_WAIT=5
DRY_RUN=0
FAIL_ON_MISSING=1

# Internal
FILES=()
PIDS=()
PID_TO_INDEX=() # keep indices aligned with PIDS
FILES_BY_PID=()
FAILED=0

# -------- Logging helpers --------
ts() { date +"%Y-%m-%dT%H:%M:%S%z"; }
log() { echo "[$(ts)] $*"; }
info() { log "INFO: $*"; }
warn() { log "WARN: $*"; }
error() { log "ERROR: $*" >&2; }
die() { error "$*"; exit 1; }

# -------- Env / deps checks --------
have_cmd() { command -v "$1" >/dev/null 2>&1; }

ensure_aws_cli() {
	have_cmd aws || die "aws CLI not found. Install AWS CLI."
}

# -------- Args parsing --------
usage() {
	cat <<EOF
Usage:
  $0 --bucket BUCKET [--prefix PREFIX] [--endpoint-url URL] [--region REGION]
     [--concurrency N] [--retries N] [--retry-wait SECONDS]
     [--verify-attempts N] [--verify-wait SECONDS]
     [--dry-run] [--fail-on-missing]
     FILE [FILE ...]

Options:
  --bucket BUCKET           Target bucket (required)
  --prefix PREFIX           Key prefix (e.g. releasesinternal). No leading slash required.
  --endpoint-url URL        S3-compatible endpoint URL (optional)
  --region REGION           AWS region (optional)
  --concurrency N           Max concurrent uploads. Default: auto (CPU count or 4)
  --retries N               Max upload attempts per file (default: ${RETRIES})
  --retry-wait SECONDS      Seconds between retries (default: ${RETRY_WAIT})
  --verify-attempts N       Max head-object polls (default: ${VERIFY_ATTEMPTS})
  --verify-wait SECONDS     Seconds between head-object polls (default: ${VERIFY_WAIT})
  --dry-run                 Print actions without executing uploads
  --fail-on-missing         Exit non-zero if no files were provided/found (default: enabled)
  -h, --help                Show this help
EOF
}

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--bucket) BUCKET="${2:-}"; shift 2 ;;
			--prefix) PREFIX="${2:-}"; shift 2 ;;
			--endpoint-url) ENDPOINT_URL="${2:-}"; shift 2 ;;
			--region) REGION="${2:-}"; shift 2 ;;
			--concurrency) CONCURRENCY="${2:-0}"; shift 2 ;;
			--retries) RETRIES="${2:-2}"; shift 2 ;;
			--retry-wait) RETRY_WAIT="${2:-10}"; shift 2 ;;
			--verify-attempts) VERIFY_ATTEMPTS="${2:-24}"; shift 2 ;;
			--verify-wait) VERIFY_WAIT="${2:-5}"; shift 2 ;;
			--dry-run) DRY_RUN=1; shift ;;
			--fail-on-missing) FAIL_ON_MISSING=1; shift ;;
			--no-fail-on-missing) FAIL_ON_MISSING=0; shift ;;
			-h|--help) usage; exit 0 ;;
			--) shift; break ;;
			-*) die "Unknown option: $1" ;;
			*) FILES+=("$1"); shift ;;
		esac
	done

	# Append remaining args as files if any (after --)
	while [[ $# -gt 0 ]]; do
		FILES+=("$1")
		shift
	done

	[[ -n "$BUCKET" ]] || die "--bucket is required"
	# Normalize PREFIX (no leading slash)
	PREFIX="${PREFIX#/}"
}

# -------- Utility helpers --------
trim() {
	# shellcheck disable=SC2001
	sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' <<< "$1"
}

file_size_bytes() {
	# Cross-platform file size (handles macOS, Linux, Git-Bash). Fall back to wc -c.
	local f="$1" out=""
	if stat -f%z "$f" >/dev/null 2>&1; then
		out="$(stat -f%z "$f")"
	elif stat -c%s "$f" >/dev/null 2>&1; then
		out="$(stat -c%s "$f")"
	else
		# Portable fallback (slower but reliable)
		out="$(wc -c < "$f" | awk '{print $1}')"
	fi
	trim "$out"
}

cpu_count() {
	if have_cmd nproc; then nproc
	elif have_cmd sysctl; then sysctl -n hw.ncpu
	else echo 4
	fi
}

# Build common AWS args array
# aws_common_args removed; build args inline in callers for bash 3 compatibility

# (Removed MOCK_AWS shim; using real AWS CLI)

# -------- Core upload + verification --------
put_object() {
	local file="$1" key="$2"
	local args=()
	[[ -n "$ENDPOINT_URL" ]] && args+=(--endpoint-url "$ENDPOINT_URL")
	[[ -n "$REGION" ]] && args+=(--region "$REGION")

	if (( DRY_RUN )); then
		info "[DRY-RUN] aws s3api put-object --bucket \"$BUCKET\" --key \"$key\" --body \"$file\" ${args[*]}"
		return 0
	fi

	aws s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" "${args[@]}"
}

head_object_size() {
	local key="$1"
	local args=()
	[[ -n "$ENDPOINT_URL" ]] && args+=(--endpoint-url "$ENDPOINT_URL")
	[[ -n "$REGION" ]] && args+=(--region "$REGION")

	# Return empty string on error
	if ! out=$(aws s3api head-object --bucket "$BUCKET" --key "$key" --query 'ContentLength' --output text "${args[@]}" 2>/dev/null); then
		echo ""
		return 1
	fi
	trim "$out"
}

upload_and_verify_once() {
	local file="$1" key="$2" size="$3"

	if ! put_object "$file" "$key"; then
		return 1
	fi

	# Poll until ContentLength matches
	local got="" attempt=1
	while (( attempt <= VERIFY_ATTEMPTS )); do
		got="$(head_object_size "$key" || true)"
		if [[ -n "$got" && "$got" == "$size" ]]; then
			info "Verified $file ($size bytes) at s3://$BUCKET/$key"
			return 0
		fi
		sleep "$VERIFY_WAIT"
		((attempt++))
	done

	error "Verification timeout for $file (expected $size, got ${got:-<none>})"
	return 1
}

upload_with_retries() {
	local file="$1"
	local filename
	filename="$(basename "$file")"
	local key="$filename"
	[[ -n "$PREFIX" ]] && key="${PREFIX%/}/$filename"

	if [[ ! -f "$file" ]]; then
		error "Not a regular file: $file"
		return 1
	fi

	local size
	size="$(file_size_bytes "$file")"

	info "Uploading $filename (${size} bytes) -> s3://$BUCKET/$key"
	local attempt=1
	while (( attempt <= RETRIES )); do
		if upload_and_verify_once "$file" "$key" "$size"; then
			return 0
		fi
		if (( attempt < RETRIES )); then
			warn "Attempt $attempt/$RETRIES failed for $filename. Retrying in ${RETRY_WAIT}s..."
			sleep "$RETRY_WAIT"
		fi
		((attempt++))
	done

	error "All $RETRIES attempts failed for $filename"
	return 1
}

# -------- Concurrency control (portable) --------
# Limit concurrent background jobs using 'jobs -pr' (works on bash 3+)
launch_job() {
	local file="$1"
	upload_with_retries "$file" &
	local pid=$!
	PIDS+=("$pid")
	FILES_BY_PID+=("$file")
}

throttle() {
	local max="$1"
	# If max <= 0, no throttling
	(( max <= 0 )) && return 0
	while true; do
		local running
		# 'jobs -pr' prints PIDs of running jobs
		running=$(jobs -pr | wc -l | awk '{print $1}')
		(( running < max )) && break
		sleep 0.2
	done
}

wait_all() {
	local any_fail=0
	# Disable set -e while collecting statuses
	set +e
	for i in "${!PIDS[@]}"; do
		local pid="${PIDS[$i]}"
		local f="${FILES_BY_PID[$i]}"
		if ! wait "$pid"; then
			error "Background upload failed: $f"
			any_fail=1
		fi
	done
	set -e
	return "$any_fail"
}

# -------- Main --------
main() {
	parse_args "$@"
	ensure_aws_cli

	# Expand potential globs if the caller quoted them.
	# In most CI shells, globs expand before reaching this script, so this is a no-op.
	shopt -s nullglob

	# Validate files
	if ((${#FILES[@]} == 0)); then
		if (( FAIL_ON_MISSING )); then
			die "No files provided."
		else
			warn "No files provided; exiting successfully due to --no-fail-on-missing."
			exit 0
		fi
	fi

	# Filter out non-existent entries defensively
	local filtered=()
	for f in "${FILES[@]}"; do
		if [[ -f "$f" ]]; then
			filtered+=("$f")
		else
			warn "Skipping non-existent path: $f"
		fi
	done
	FILES=("${filtered[@]}")

	if ((${#FILES[@]} == 0)); then
		if (( FAIL_ON_MISSING )); then
			die "No existing files to upload."
		else
			warn "No existing files to upload; exiting successfully due to --no-fail-on-missing."
			exit 0
		fi
	fi

	# Determine concurrency
	if (( CONCURRENCY <= 0 )); then
		CONCURRENCY="$(cpu_count)"
		# Avoid overload: cap to 8 by default
		(( CONCURRENCY > 8 )) && CONCURRENCY=8
	fi

	info "Starting ${#FILES[@]} upload(s) with concurrency=${CONCURRENCY}, retries=${RETRIES}, verify_attempts=${VERIFY_ATTEMPTS}"

	# Launch jobs
	for f in "${FILES[@]}"; do
		throttle "$CONCURRENCY"
		launch_job "$f"
	done

	# Wait and collect statuses
	if ! wait_all; then
		FAILED=1
	fi

	if (( FAILED )); then
		die "One or more uploads failed or did not verify."
	fi
	info "All uploads completed and verified."
}

# -------- Entry --------


main "$@"