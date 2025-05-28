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
  if (process.env.WEB_CODECS_ENCODER_SKIP_COPY) {
    console.log('WEB_CODECS_ENCODER_SKIP_COPY is set, skipping worker copy.');
    return;
  }
  
  // まず、ローカル開発用にdistディレクトリにwebcodecs-worker.jsを作成
  try {
    const localWorkerSource = path.join(packageRoot, 'dist', 'worker.js');
    const localWorkerDest = path.join(packageRoot, 'dist', 'webcodecs-worker.js');
    
    if (fs.existsSync(localWorkerSource)) {
      fs.copyFileSync(localWorkerSource, localWorkerDest);
      console.log('✅ Created webcodecs-worker.js in dist directory for local development');
    }
  } catch (error) {
    console.warn('⚠️ Could not create local webcodecs-worker.js:', error.message);
  }
  
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
        const workerDestination = path.join(publicDir, 'webcodecs-worker.js');
        
        const workerCopied = safeCopy(workerSource, workerDestination);
        
        if (workerCopied) {
          copied = true;
          break; // Only copy to the first available public directory
        }
      }
    }
    
    if (!copied) {
      // Try to create a public directory
      const publicDir = path.join(projectRoot, 'public');
      const workerDestination = path.join(publicDir, 'webcodecs-worker.js');
      
      const workerCopied = safeCopy(workerSource, workerDestination);
      
      if (workerCopied) {
        copied = true;
      }
    }
    
    if (copied) {
      console.log('\n🎉 WebCodecs Encoder is ready to use!');
      console.log('Worker files have been automatically copied to your public directory.');
      console.log('\nUsage:');
      console.log('  import { encode, canEncode } from "webcodecs-encoder";');
      console.log('  const isSupported = await canEncode();');
      console.log('  const mp4Data = await encode(frames, { quality: "medium" });');
    } else {
      console.log('\n⚠️  WebCodecs Encoder setup info:');
      console.log('Unable to auto-copy worker files. You may need to copy them manually:');
      console.log('  1. Copy node_modules/webcodecs-encoder/dist/worker.js to your public directory as webcodecs-worker.js');
      console.log('\nOr specify custom worker URLs in your bundler configuration.');
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