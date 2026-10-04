// Makes sure the prebuilt Windows binaries for the integrated terminal (node-pty) are present
// in node_modules. npm only installs the package for the current OS, so when building the
// Windows .exe from Linux/macOS we fetch @lydell/node-pty-win32-x64 explicitly.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ptyPkg = require(path.join(root, 'node_modules/@lydell/node-pty/package.json'));
const name = '@lydell/node-pty-win32-x64';
const version = ptyPkg.optionalDependencies[name];
const target = path.join(root, 'node_modules', name);

if (fs.existsSync(path.join(target, 'package.json'))) {
  console.log(`${name} already present`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-pty-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
console.log(`Fetching ${name}@${version}…`);
const out = execFileSync(npm, ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], {
  cwd: tmp,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim();
const tgz = path.join(tmp, out.split('\n').pop().trim());
fs.mkdirSync(target, { recursive: true });
execFileSync('tar', ['-xzf', tgz, '-C', target, '--strip-components=1']);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Installed ${name} into node_modules`);
