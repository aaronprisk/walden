const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { globby } = require('globby');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('src/index.html');
}

app.whenReady().then(createWindow);

// Dynamically stored active path states
let activeRepoLocalPath = null; 
let currentEnginePath = null; 

// Sync Repository (Clone or Pull)
ipcMain.handle('sync-repository', async (event, { username, repo, token, engine }) => {
  const repoUrl = `https://github.com/${username}/${repo}.git`;
  const safeRepoFolderName = `.walden-cache-${repo.replace(/[^a-zA-Z0-9]/g, '-')}`;
  activeRepoLocalPath = path.join(app.getPath('home'), safeRepoFolderName);

  const targetSubFolder = engine === 'jekyll' ? '_posts' : 'blog';
  currentEnginePath = path.join(activeRepoLocalPath, targetSubFolder);

  try {
    if (!fs.existsSync(activeRepoLocalPath)) {
      await git.clone({
        fs,
        http,
        dir: activeRepoLocalPath,
        url: repoUrl,
        onAuth: () => ({ username: token }),
        singleBranch: true,
        depth: 1
      });
    } else {
      await git.pull({
        fs,
        http,
        dir: activeRepoLocalPath,
        ref: 'main', 
        onAuth: () => ({ username: token }),
        author: { name: username, email: `${username}@users.noreply.github.com` }
      });
    }

    if (!fs.existsSync(currentEnginePath)) {
      fs.mkdirSync(currentEnginePath);
    }

    return currentEnginePath;
  } catch (err) {
    throw new Error(err.message);
  }
});

// Read Local Markdown Directory Files
ipcMain.handle('read-directory', async () => {
  try {
    if (!currentEnginePath || !fs.existsSync(currentEnginePath)) return [];
    const files = fs.readdirSync(currentEnginePath);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, path: path.join(currentEnginePath, f) }));
  } catch (err) {
    throw new Error(err.message);
  }
});

// Read File Content
ipcMain.handle('read-file', async (event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

// Save Local Draft Document
ipcMain.handle('write-file', async (event, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

// Native Image Asset Ingestion Pipeline
ipcMain.handle('select-and-copy-image', async (event) => {
  if (!activeRepoLocalPath) {
    throw new Error("No active repository workspace path is initialized.");
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Image Asset for Entry',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const sourceImagePath = result.filePaths[0];
  const imageExt = path.extname(sourceImagePath);
  
  // Save directly to the root img folder of your website repo
  const targetImgFolder = path.join(activeRepoLocalPath, 'img');
  if (!fs.existsSync(targetImgFolder)) {
    fs.mkdirSync(targetImgFolder, { recursive: true });
  }

  const cleanFilename = `asset-${Date.now()}${imageExt}`;
  const destinationPath = path.join(targetImgFolder, cleanFilename);

  fs.copyFileSync(sourceImagePath, destinationPath);

  // Returns 'img/asset-xyz.png' to the frontend editor
  return `img/${cleanFilename}`;
});

// Audio Asset Pipeline
ipcMain.handle('select-and-copy-audio', async (event, suggestedSlug) => {
  if (!activeRepoLocalPath) {
    throw new Error("No active repository workspace path is initialized.");
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio Asset for Entry',
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav'] }],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const sourceAudioPath = result.filePaths[0];
  const audioExt = path.extname(sourceAudioPath);
  
  // Push file to audio directory
  const targetAudioFolder = path.join(activeRepoLocalPath, 'audio');
  if (!fs.existsSync(targetAudioFolder)) {
    fs.mkdirSync(targetAudioFolder, { recursive: true });
  }

  // Use the article slug if provided, otherwise use timestamp
  const cleanFilename = suggestedSlug ? `${suggestedSlug}${audioExt}` : `audio-${Date.now()}${audioExt}`;
  const destinationPath = path.join(targetAudioFolder, cleanFilename);

  fs.copyFileSync(sourceAudioPath, destinationPath);

  // Return file name to the editor
  return `audio/${cleanFilename}`;
});

// Publish Git Commit and Push
ipcMain.handle('publish-git', async (event, { filename, username, token }) => {
  try {
    const relativeFolder = currentEnginePath.endsWith('_posts') ? '_posts' : 'blog';
    
    // We target files explicitly by removing the dot prefix so isomorphic-git processes them correctly
    const activePaths = await globby([`${relativeFolder}/**`, 'img/**', 'audio/**'], { 
      cwd: activeRepoLocalPath,
      gitignore: false // Disable gitignore check so newly created local asset trees are fully parsed
    });

    for (const filepath of activePaths) {
      await git.add({ 
        fs, 
        dir: activeRepoLocalPath, 
        filepath: filepath
      });
    }

    await git.commit({
      fs,
      dir: activeRepoLocalPath,
      message: `Published entry via Walden: ${filename}`,
      author: { name: username, email: `${username}@users.noreply.github.com` }
    });

    await git.push({
      fs,
      http,
      dir: activeRepoLocalPath,
      ref: 'main',
      onAuth: () => ({ username: token })
    });

    return true;
  } catch (err) {
    throw new Error(err.message);
  }
});

// Delete post from local draft and repo
ipcMain.handle('delete-post', async (event, { filePath, filename, username, token }) => {
  try {
    if (!activeRepoLocalPath) {
      throw new Error("No active repository workspace path is initialized.");
    }

    // Determine draft path
    const relativeFilePath = path.relative(activeRepoLocalPath, filePath);

    // Delete local draft
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Stage the file deletion
    await git.remove({
      fs,
      dir: activeRepoLocalPath,
      filepath: relativeFilePath
    });

    // Commit the deletion
    await git.commit({
      fs,
      dir: activeRepoLocalPath,
      message: `Deleted entry via Walden: ${filename}`,
      author: { name: username, email: `${username}@users.noreply.github.com` }
    });

    // Push the delete commit
    await git.push({
      fs,
      http,
      dir: activeRepoLocalPath,
      ref: 'main',
      onAuth: () => ({ username: token })
    });

    return true;
  } catch (err) {
    throw new Error(err.message);
  }
});
