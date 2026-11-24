// Sign the packed app (no Apple Developer ID needed): Apple Silicon refuses to run unsigned code, and a stable
// signing identity lets macOS keep the app's Keychain access and permissions across updates. Runs before dmg/zip.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // node-pty's helper must be executable (npm may install it without the bit).
  execFileSync('/bin/sh', ['-c', `find "${app}/Contents/Resources/app/node_modules/node-pty" -name spawn-helper -exec chmod 755 {} +`], { stdio: 'inherit' });
  // Ad hoc by default. Set IRIS_SIGN_IDENTITY (and IRIS_SIGN_KEYCHAIN) to sign with an identity of your own.
  const identity = process.env.IRIS_SIGN_IDENTITY;
  const keychain = process.env.IRIS_SIGN_KEYCHAIN;
  const sign = identity ? ['--sign', identity, ...(keychain ? ['--keychain', keychain] : [])] : ['--sign', '-'];
  execFileSync('codesign', ['--force', '--deep', ...sign, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
