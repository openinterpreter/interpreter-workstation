abi <abi/4.0>,
include <tunables/global>

# Pinned copy of electron-builder's default AppArmor template so the userns
# allowance is explicit and version-controlled rather than relying on the
# packager's bundled default. electron-builder substitutes the executable and
# product-name placeholders at package time and installs this under
# /etc/apparmor.d via the .deb post-install hook (skipped on AppArmor versions
# without abi/4.0, e.g. Ubuntu 22.04).
# Allows the unprivileged user namespace Chromium's renderer sandbox needs on
# Ubuntu 24.04 (kernel.apparmor_restrict_unprivileged_userns=1).
#
# Prior art for the .deb sandbox-keeps-working approach:
# - Signal-Desktop ships this same electron-builder userns profile to /etc/apparmor.d
#   unchanged (signalapp/Signal-Desktop patches/app-builder-lib.patch leaves the
#   templates/linux/after-install.tpl AppArmor block as upstream context).
# - VS Code instead ships chrome-sandbox SUID 4755 to keep the setuid sandbox working
#   (microsoft/vscode resources/linux/rpm/code.spec.template). electron-builder does both
#   (this profile + a SUID chrome-sandbox fallback in after-install.tpl).
# See: https://github.com/openinterpreter/iworkstation/issues/1397
# See: https://github.com/electron/electron/issues/41066
# See: https://github.com/electron-userland/electron-builder/pull/8636 (AppArmor support)
profile ${executable} "/opt/${sanitizedProductName}/${executable}" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
