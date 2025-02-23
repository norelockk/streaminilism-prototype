// scripts/launcher.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuration
const config = {
  distDir: path.join(process.cwd(), 'dist'),
  goSourceDir: path.join(process.cwd(), 'src', 'go'),
  goBinaryName: process.platform === 'win32' ? 'bunny-upload.exe' : 'bunny-upload',
};

function spawnProcess(command, args, options = {}) {
  const isWindows = process.platform === 'win32';
  const finalCommand = isWindows && command === 'npm' ? 'npm.cmd' : command;

  return new Promise((resolve, reject) => {
    const proc = spawn(finalCommand, args, { 
      ...options, 
      stdio: 'inherit', 
      shell: isWindows 
    });
    
    proc.on('error', (error) => {
      console.error(`Failed to start process: ${error.message}`);
      reject(error);
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

// Build functions
function isBinaryUpToDate() {
  const goBinaryPath = path.join(config.goSourceDir, config.goBinaryName);
  if (!fs.existsSync(goBinaryPath)) {
    return false;
  }

  const binaryStat = fs.statSync(goBinaryPath);
  const sourceFiles = fs.readdirSync(config.goSourceDir);
  for (const file of sourceFiles) {
    const filePath = path.join(config.goSourceDir, file);
    if (fs.statSync(filePath).mtimeMs > binaryStat.mtimeMs) {
      return false;
    }
  }

  return true;
}

async function buildGoBinary() {
  if (isBinaryUpToDate()) {
    console.log('Go binary is up to date');
    return;
  }

  console.log('Building Go binary...');
  try {
    await spawnProcess('go', ['build', '-o', config.goBinaryName], {
      cwd: config.goSourceDir
    });
    console.log('Go binary built successfully');
  } catch (error) {
    console.error('Failed to build Go binary:', error);
    throw error;
  }
}

async function buildTypeScript() {
  console.log('Building TypeScript...');
  try {
    await spawnProcess('npm', ['exec', 'tsc'], {
      cwd: process.cwd()
    });
    console.log('TypeScript built successfully');
  } catch (error) {
    console.error('Failed to build TypeScript:', error);
    throw error;
  }
}

async function clean() {
  console.log('Cleaning build directories...');
  try {
    // Remove dist directory
    if (fs.existsSync(config.distDir)) {
      await fs.promises.rm(config.distDir, { recursive: true, force: true });
    }
    
    // Remove Go binary
    const goBinaryPath = path.join(config.goSourceDir, config.goBinaryName);
    if (fs.existsSync(goBinaryPath)) {
      await fs.promises.unlink(goBinaryPath);
    }
    
    console.log('Clean completed');
  } catch (error) {
    console.error('Failed to clean directories:', error);
    throw error;
  }
}

async function startDev() {
  console.log('Starting development server...');
  try {
    await spawnProcess('npm', ['exec', '--', 'ts-node', '--files', 'src/index.ts'], {
      env: { ...process.env, NODE_ENV: 'development' }
    });
  } catch (error) {
    console.error('Failed to start development server:', error);
    throw error;
  }
}

async function startDevWatch() {
  console.log('Starting development server with watch mode...');
  try {
    await spawnProcess('npm', ['exec', '--', 'ts-node-dev', '--respawn', '--files', 'src/index.ts'], {
      env: { ...process.env, NODE_ENV: 'development' }
    });
  } catch (error) {
    console.error('Failed to start development server:', error);
    throw error;
  }
}

async function start() {
  console.log('Starting production server...');
  try {
    await spawnProcess('node', ['--expose-gc', 'dist/index.js'], {
      env: { ...process.env, NODE_ENV: 'production' }
    });
  } catch (error) {
    console.error('Failed to start production server:', error);
    throw error;
  }
}

// Command handler
async function handleCommand(command) {
  try {
    switch (command) {
      case 'build':
        await buildGoBinary();
        await buildTypeScript();
        break;
      
      case 'build:go':
        await buildGoBinary();
        break;
      
      case 'build:ts':
        await buildTypeScript();
        break;
      
      case 'clean':
        await clean();
        break;
      
      case 'build:clean':
        await clean();
        await buildGoBinary();
        await buildTypeScript();
        break;
      
      case 'dev':
        await buildGoBinary();
        await startDev();
        break;
      
      case 'dev:watch':
        await buildGoBinary();
        await startDevWatch();
        break;
      
      case 'start':
        await start();
        break;
      
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Command failed:', error);
    process.exit(1);
  }
}

// Main execution
const command = process.argv[2];
if (!command) {
  console.error('Please specify a command');
  process.exit(1);
}

handleCommand(command);