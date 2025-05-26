#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * WebCodecs Encoder Post-install Script
 * 
 * Automatically copies worker files to common public directories
 * for seamless integration with Vite, Create React App, and other bundlers.
 */

// Find the package root (where this script is located)
const packageRoot = path.resolve(__dirname, '..');
const workerSource = path.join(packageRoot, 'dist', 'worker.js');

// Also check the actual file location for better detection
const scriptPath = fileURLToPath(import.meta.url);
const actualPackageRoot = path.dirname(path.dirname(scriptPath));

// Common public directory patterns
const publicDirPatterns = [
  'public',
  'src/public', 
  'public_html',
  'static',
  'assets'
];

// Function to safely copy file
function safeCopy(source, destination) {
  try {
    // Create directory if it doesn't exist
    const destDir = path.dirname(destination);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    // Copy the file
    fs.copyFileSync(source, destination);
    console.log(`✅ WebCodecs worker copied to: ${destination}`);
    return true;
  } catch (error) {
    // Silently ignore errors - this is best effort
    return false;
  }
}

// Main installation logic
function installWorker() {
  // Check if we're being run from within node_modules via package path
  const cwd = process.cwd();
  const packagePath = packageRoot;
  // Use process.cwd() to check if we're running from within node_modules
  const currentPath = process.cwd();
  
  // Check if npm is installing us as a dependency
  const isNpmInstall = process.env.npm_lifecycle_event === 'postinstall';
  const isInstalledAsPackage = packagePath.includes('node_modules') || actualPackageRoot.includes('node_modules') || currentPath.includes('node_modules') || isNpmInstall;
  
  if (isInstalledAsPackage) {
    // We're being installed as a dependency, try to copy to parent project
    // When npm runs postinstall, cwd is still the original package directory
    // We need to find the actual project that's installing us
    let projectRoot;
    if (process.env.INIT_CWD) {
      // npm sets INIT_CWD to the directory where npm was originally run
      projectRoot = process.env.INIT_CWD;
    } else {
      // Fallback: try to find node_modules parent
      projectRoot = cwd.split('node_modules')[0];
    }
    let copied = false;
    
    for (const pattern of publicDirPatterns) {
      const publicDir = path.join(projectRoot, pattern);
      if (fs.existsSync(publicDir)) {
        const destination = path.join(publicDir, 'webcodecs-worker.js');
        if (safeCopy(workerSource, destination)) {
          copied = true;
          break; // Only copy to the first available public directory
        }
      }
    }
    
    if (!copied) {
      // Try to create a public directory
      const publicDir = path.join(projectRoot, 'public');
      const destination = path.join(publicDir, 'webcodecs-worker.js');
      if (safeCopy(workerSource, destination)) {
        copied = true;
      }
    }
    
    if (copied) {
      console.log('\n🎉 WebCodecs Encoder is ready to use!');
      console.log('The worker file has been automatically copied to your public directory.');
      console.log('\nUsage:');
      console.log('  const encoder = new WebCodecsEncoder(config);');
      console.log('  await encoder.initialize(); // Worker will be found automatically');
    } else {
      console.log('\n⚠️  WebCodecs Encoder setup info:');
      console.log('Unable to auto-copy worker file. You may need to copy it manually:');
      console.log(`  cp node_modules/webcodecs-encoder/dist/worker.js public/webcodecs-worker.js`);
      console.log('\nOr specify the worker URL manually:');
      console.log('  await encoder.initialize({ workerScriptUrl: "/path/to/worker.js" });');
    }
  }
}

// Only run if this script is executed directly (not imported as module)
// Check if this file is being run directly
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  installWorker();
}

export { installWorker, safeCopy }; 