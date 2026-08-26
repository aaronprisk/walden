const { ipcRenderer } = require('electron');

// Initialize the Text Editor Interface
const easyMDE = new EasyMDE({ 
  element: document.getElementById('markdown-editor'),
  spellChecker: true,
  status: false,
  // Custom preview system for local asset handling
  previewRender: function(plainText) {
    let processedText = plainText;
    if (currentWorkspacePath) {
      const path = require('path');
      const rootDir = path.dirname(currentWorkspacePath); 
      const fileUri = 'file://' + rootDir.replace(/\\/g, '/'); 
      processedText = processedText.replace(/\]\(\/(img|audio)\//g, `](${fileUri}/$1/`);
      processedText = processedText.replace(/src="\/(img|audio)\//g, `src="${fileUri}/$1/`);
    }
    return this.parent.markdown(processedText);
  },
  toolbar: [
    "bold", "italic", "heading", "|", 
    "quote", "unordered-list", "ordered-list", "|", 
    "link", 
    // Custom image upload and processing
    {
      name: "custom-image",
      action: async function drawImageButton(editor) {
        try {
          const relativeAssetPath = await ipcRenderer.invoke('select-and-copy-image');
          
          if (relativeAssetPath) {
            const cm = editor.codemirror;
            const doc = cm.getDoc();
            const cursor = doc.getCursor();
            
            // Forces absolute root targeting to dodge Jekyll's nested layout paths
            doc.replaceRange(`![Image Description](/${relativeAssetPath})`, cursor);
          }
        } catch (err) {
          alert("Image ingestion failed: " + err.message);
        }
      },
      className: "fa fa-picture-o",
      title: "Insert Local Image Asset",
    },
    {
      name: "custom-audio",
      action: async function drawAudioButton(editor) {
        try {
          // Grab the title to format the filename
          const titleValue = document.getElementById('post-title').value.trim();
          const slugTitle = titleValue 
            ? titleValue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') 
            : null;

          const relativeAssetPath = await ipcRenderer.invoke('select-and-copy-audio', slugTitle);
          
          if (relativeAssetPath) {
            const cm = editor.codemirror;
            const doc = cm.getDoc();
            const cursor = doc.getCursor();
            
            // Insert HTML5 audio element
            doc.replaceRange(`\n<audio controls src="/${relativeAssetPath}"></audio>\n`, cursor);
          }
        } catch (err) {
          alert("Audio ingestion failed: " + err.message);
        }
      },
      className: "fa fa-music",
      title: "Insert Local Audio Asset",
    },
    "|", 
    "preview", "side-by-side", "fullscreen", "|", 
    "guide"
  ]
});

let currentWorkspacePath = null;
let currentOpenFilepath = null;

// On App Boot, restore config and auto-sync repository
window.addEventListener('DOMContentLoaded', async () => {
  const user = localStorage.getItem('walden_user') || '';
  const repo = localStorage.getItem('walden_repo') || '';
  const token = localStorage.getItem('walden_token') || '';
  const engine = localStorage.getItem('walden_engine') || 'jekyll'; // Default to jekyll

  document.getElementById('cfg-username').value = user;
  document.getElementById('cfg-repo').value = repo;
  document.getElementById('cfg-token').value = token;
  document.getElementById('cfg-engine').value = engine;
  
  if (!token || !user || !repo) {
    toggleSettings(true);
  } else {
    await runRepositorySync(user, repo, token, engine);
  }
});

// UI Panel Toggles
const settingsPanel = document.getElementById('settings-panel');
const toggleSettings = (open) => settingsPanel.classList.toggle('open', open);
document.getElementById('toggle-settings-btn').addEventListener('click', () => toggleSettings(true));
document.getElementById('close-settings-btn').addEventListener('click', () => toggleSettings(false));

// Save Configuration and fire off initial sync
document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const user = document.getElementById('cfg-username').value.trim();
  const repo = document.getElementById('cfg-repo').value.trim();
  const token = document.getElementById('cfg-token').value.trim();
  const engine = document.getElementById('cfg-engine').value;

  localStorage.setItem('walden_user', user);
  localStorage.setItem('walden_repo', repo);
  localStorage.setItem('walden_token', token);
  localStorage.setItem('walden_engine', engine);
  
  alert("Settings updated safely. Syncing with GitHub...");
  toggleSettings(false);
  await runRepositorySync(user, repo, token, engine);
});

// Git Synchronizer
async function runRepositorySync(username, repo, token, engine) {
  const listContainer = document.getElementById('posts-list');
  listContainer.innerHTML = '<li class="post-item" style="color:#888; text-align:center;">Syncing cabin logs...</li>';
  
  try {
    currentWorkspacePath = await ipcRenderer.invoke('sync-repository', { username, repo, token, engine });
    await refreshFilesList();
  } catch (err) {
    alert("Sync error: " + err.message);
    listContainer.innerHTML = '<li class="post-item" style="color:red; text-align:center;">Sync failed</li>';
  }
}

// Scan directory and populate sidebar
async function refreshFilesList() {
  try {
    const files = await ipcRenderer.invoke('read-directory');
    const listContainer = document.getElementById('posts-list');
    listContainer.innerHTML = '';

    if (files.length === 0) {
      listContainer.innerHTML = '<li class="post-item" style="color:#888; text-align:center;">No entries found</li>';
      return;
    }

    files.forEach(file => {
      const li = document.createElement('li');
      li.className = 'post-item';
      li.innerText = file.name;
      li.addEventListener('click', () => loadLocalFile(file.path, file.name));
      listContainer.appendChild(li);
    });
  } catch (err) {
    alert("Error loading sidebar lists: " + err);
  }
}

// Open and parse file
async function loadLocalFile(filePath, filename) {
  try {
    const rawContent = await ipcRenderer.invoke('read-file', filePath);
    currentOpenFilepath = filePath;

    let cleanContent = rawContent;
    let extractedTitle = filename.replace('.md', '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
    let extractedDesc = "";
    let extractedTags = "";

    // Parse Front Matter if present
    if (rawContent.startsWith('---')) {
      const sections = rawContent.split('---');
      if (sections.length >= 3) {
        cleanContent = sections.slice(2).join('---').trim();
        
        const lines = sections[1].split('\n');
        lines.forEach(line => {
          const [key, ...valParts] = line.split(':');
          if (key && valParts.length) {
            const rawValue = valParts.join(':').trim();
            const cleanValue = rawValue.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

            if (key.trim() === 'title') {
              extractedTitle = cleanValue;
            } else if (key.trim() === 'description') {
              extractedDesc = cleanValue;
            } else if (key.trim() === 'tags') {
              extractedTags = cleanValue.replace(/[\[\]]/g, '');
            }
          }
        });
      }
    }

    document.getElementById('post-title').value = extractedTitle;
    document.getElementById('post-desc').value = extractedDesc;
    document.getElementById('post-tags').value = extractedTags;
    easyMDE.value(cleanContent);
  } catch (err) {
    alert("Failed to read file: " + err);
  }
}

// Reset view for a New Post
document.getElementById('new-btn').addEventListener('click', () => {
  currentOpenFilepath = null;
  document.getElementById('post-title').value = '';
  document.getElementById('post-desc').value = '';
  document.getElementById('post-tags').value = '';
  easyMDE.value('');
});

// Manual Upstream Synchronizer Button Event Listener
document.getElementById('sync-btn').addEventListener('click', async () => {
  const user = localStorage.getItem('walden_user');
  const repo = localStorage.getItem('walden_repo');
  const token = localStorage.getItem('walden_token');
  const engine = localStorage.getItem('walden_engine') || 'jekyll';

  if (!token || !user || !repo) {
    return alert("Please complete your setup configuration profile before attempting a sync execution.");
  }

  const syncBtn = document.getElementById('sync-btn');
  const originalText = syncBtn.innerText;
  syncBtn.innerText = "⌛ ...";
  syncBtn.disabled = true;

  try {
    await runRepositorySync(user, repo, token, engine);
    alert("Workspace successfully aligned! Pulled down the latest changes from your remote GitHub repository branch.");
  } catch (err) {
    alert(`Sync Failure: ${err.message}`);
  } finally {
    syncBtn.innerText = originalText;
    syncBtn.disabled = false;
  }
});

// Save Local Draft
document.getElementById('save-local-btn').addEventListener('click', async () => {
  const title = document.getElementById('post-title').value.trim();
  const content = easyMDE.value();
  const description = document.getElementById('post-desc').value.trim();
  const rawTags = document.getElementById('post-tags').value.trim();

  if (!title) return alert("Please add a title before saving.");
  if (!currentWorkspacePath) return alert("Please finish setup configuration first.");

  const engine = localStorage.getItem('walden_engine') || 'jekyll';
  const cleanSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  
  let expectedFilename;
  if (engine === 'jekyll') {
    const datePrefix = new Date().toISOString().split('T')[0];
    expectedFilename = `${datePrefix}-${cleanSlug}.md`;
  } else {
    expectedFilename = `${cleanSlug}.md`;
  }

  const path = require('path');
  let targetPath = currentOpenFilepath;

  if (!targetPath) {
    targetPath = path.join(currentWorkspacePath, expectedFilename);
  }

  let tagsBlock = "";
  if (rawTags) {
    const formattedTags = rawTags.split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .join(', ');
    tagsBlock = `\ntags: [${formattedTags}]`;
  }

  const fileBody = `---
layout: post
title: "${title}"
date: ${new Date().toISOString().split('T')[0]}
description: "${description.replace(/"/g, '\\"')}"${tagsBlock}
---

${content}`;

  try {
    await ipcRenderer.invoke('write-file', { filePath: targetPath, content: fileBody });
    currentOpenFilepath = targetPath;
    alert("Draft saved safely to local workspace.");
    await refreshFilesList();
  } catch (err) {
    alert("Failed to write draft: " + err);
  }
});

// Publish direct to Git (With Auto-Save Fail-Safe)
document.getElementById('publish-btn').addEventListener('click', async () => {
  const title = document.getElementById('post-title').value.trim();
  const content = easyMDE.value();
  const description = document.getElementById('post-desc').value.trim();
  const rawTags = document.getElementById('post-tags').value.trim();
  const token = localStorage.getItem('walden_token');
  const user = localStorage.getItem('walden_user');

  if (!title) return alert("Please add a title before publishing.");
  if (!currentWorkspacePath) return alert("Please finish setup configuration first.");

  // Automatically save draft to local
  const engine = localStorage.getItem('walden_engine') || 'jekyll';
  const cleanSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  
  let expectedFilename;
  if (engine === 'jekyll') {
    const datePrefix = new Date().toISOString().split('T')[0];
    expectedFilename = `${datePrefix}-${cleanSlug}.md`;
  } else {
    expectedFilename = `${cleanSlug}.md`;
  }

  const path = require('path');
  let targetPath = currentOpenFilepath;

  if (!targetPath) {
    targetPath = path.join(currentWorkspacePath, expectedFilename);
  }

  let tagsBlock = "";
  if (rawTags) {
    const formattedTags = rawTags.split(',')
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .join(', ');
    tagsBlock = `\ntags: [${formattedTags}]`;
  }

  const fileBody = `---
layout: post
title: "${title}"
date: ${new Date().toISOString().split('T')[0]}
description: "${description.replace(/"/g, '\\"')}"${tagsBlock}
---

${content}`;

  try {
    // Silently commit latest workspace updates to local disk cache first
    await ipcRenderer.invoke('write-file', { filePath: targetPath, content: fileBody });
    currentOpenFilepath = targetPath;
    await refreshFilesList();
    
    // Git commit and push process
    const filename = path.basename(currentOpenFilepath);
    alert("Draft autosaved! Staging, committing, and pushing logs to web production...");
    
    await ipcRenderer.invoke('publish-git', { filename, username: user, token });
    alert("Successfully deployed directly to your GitHub Pages blog branch!");
  } catch (error) {
    alert(`Deployment / Auto-Save Error: ${error.message}`);
  }
});


// Delete post from workspace and remote repository
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!currentOpenFilepath) {
    return alert("No file is currently open to delete!");
  }

  const title = document.getElementById('post-title').value.trim() || 'this post';
  
  // Omni Man - Are you sure?
  const isConfirmed = confirm(
    `Are you sure you want to permanently delete "${title}"?`
  );

  if (!isConfirmed) return; // User clicked Cancel

  const token = localStorage.getItem('walden_token');
  const user = localStorage.getItem('walden_user');
  const path = require('path');
  const filename = path.basename(currentOpenFilepath);

  const deleteBtn = document.getElementById('delete-btn');
  const originalText = deleteBtn.innerText;
  deleteBtn.innerText = "Deleting...";
  deleteBtn.disabled = true;

  try {
    // Tell the main process to delete the file and sync
    await ipcRenderer.invoke('delete-post', { 
      filePath: currentOpenFilepath, 
      filename, 
      username: user, 
      token 
    });

    alert("Post successfully deleted from your blog!");

    // Scrub the editor view and refresh the sidebar list
    currentOpenFilepath = null;
    document.getElementById('post-title').value = '';
    document.getElementById('post-desc').value = '';
    document.getElementById('post-tags').value = '';
    easyMDE.value('');
    
    await refreshFilesList();
  } catch (err) {
    alert(`Deletion failed: ${err.message}`);
  } finally {
    deleteBtn.innerText = originalText;
    deleteBtn.disabled = false;
  }
});
