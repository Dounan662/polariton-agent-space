import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

// Compile once with the application build; clicking + never launches an interpreter
// or compiler. Linux resolves optional desktop pickers at runtime.
if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const contents = join(root, 'dist/native/Polariton Folder Picker.app/Contents');
  await mkdir(join(contents, 'MacOS'), {recursive:true});
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>picker</string>
<key>CFBundleIdentifier</key><string>org.polariton.directory-picker</string>
<key>CFBundleName</key><string>Polariton Folder Picker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`);
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-O2', '-framework', 'Cocoa', join(root,'native/directory-picker.m'), '-o', join(contents,'MacOS/picker')], {stdio:'inherit'});
}
