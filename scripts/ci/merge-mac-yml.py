#!/usr/bin/env uv run
# /// script
# dependencies = [
#   "pyyaml",
# ]
# ///

import yaml
import sys
from pathlib import Path

def merge_latest_mac_yml(arm64_path: str, x64_path: str, output_path: str):
    """Merge latest-mac.yml files from arm64 and x64 builds."""

    with open(arm64_path, 'r') as f:
        arm64_yml = yaml.safe_load(f)
    
    with open(x64_path, 'r') as f:
        x64_yml = yaml.safe_load(f)
    
    # Start with arm64 as base (it has version and releaseDate)
    merged_yml = arm64_yml.copy()
    
    # Merge the files arrays - combine both architectures
    arm64_files = arm64_yml.get('files', [])
    x64_files = x64_yml.get('files', [])

    seen_urls = set()
    merged_files = []

    for file in arm64_files:
        url = file.get('url')
        if url and url not in seen_urls:
            seen_urls.add(url)
            merged_files.append(file)

    for file in x64_files:
        url = file.get('url')
        if url and url not in seen_urls:
            seen_urls.add(url)
            merged_files.append(file)

    merged_yml['files'] = merged_files
    
    # Keep arm64's path and sha512 as the primary/default
    # (auto-updater will choose the right file based on architecture)

    with open(output_path, 'w') as f:
        yaml.dump(merged_yml, f, default_flow_style=False, sort_keys=False)
    
    print(f"Merged latest-mac.yml written to {output_path}")
    print(f"  Total files: {len(merged_files)}")
    print(f"  - ARM64 files: {len(arm64_files)}")
    print(f"  - x64 files: {len(x64_files)}")

    print("\nMerged files:")
    for file in merged_files:
        print(f"  - {file.get('url')}")
    
    return merged_yml

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: ./merge-mac-yml.py <arm64-yml> <x64-yml> <output-yml>")
        sys.exit(1)
    
    arm64_path = sys.argv[1]
    x64_path = sys.argv[2]
    output_path = sys.argv[3]
    
    try:
        merge_latest_mac_yml(arm64_path, x64_path, output_path)
    except Exception as e:
        print(f"Error merging YAML files: {e}")
        sys.exit(1)