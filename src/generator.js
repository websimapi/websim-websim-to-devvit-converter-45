import JSZip from 'jszip';
import { 
    cleanName, 
    AssetAnalyzer 
} from './processors.js';

import { EMPTY_PNG, EMPTY_WAV } from './api/assets.js';

import {
    generatePackageJson,
    generateDevvitJson,
    generateClientViteConfig,
    generateServerViteConfig,
    tsConfig,
    getMainTs,
    simpleLoggerJs,
    webAudioPolyfill,
    websimSocketPolyfill,
    websimStubsJs,
    websimPackageJs,
    jsxDevProxy,
    avatarInjector,
    validateScript,
    setupScript,
    generateReadme,
    generateLauncherHtml,
    protobufInquireStub
} from './templates.js';

export async function generateDevvitZip(projectMeta, assets, includeReadme = true, launchMode = 'inline') {
    const zip = new JSZip();
    
    const safeId = projectMeta.project.id ? projectMeta.project.id.slice(0, 4) : '0000';
    const rawSlug = cleanName(projectMeta.project.slug || "websim-game");
    const truncatedSlug = rawSlug.slice(0, 11);
    const projectSlug = `${truncatedSlug}-${safeId}`;
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // Initialize Analyzer
    const analyzer = new AssetAnalyzer();
    
    // Separation: Code vs Static Assets
    const codeFiles = {};
    const staticFiles = {}; // These go to src/client/public/
    const urlMap = new Map(); // original -> clean filename

    console.log(`[Generator] Generating Zip. Input files: ${Object.keys(assets).length}`);
    
    // 1. Initial Sort & Clean
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        // Code Files
        if (/\.(html|js|mjs|ts|jsx|tsx|css|json|txt|md)$/i.test(path)) {
            codeFiles[path] = content;
        } else {
            // Static Assets (Images, Audio, Models)
            const name = path.split('/').pop();
            const clean = cleanName(name);
            
            // Avoid overwrite collision
            let finalName = clean;
            let counter = 1;
            while (staticFiles[finalName]) {
                const parts = clean.split('.');
                const ext = parts.pop();
                const base = parts.join('.');
                finalName = `${base}_${counter}.${ext}`;
                counter++;
            }

            staticFiles[finalName] = content;
            
            // Map common ways this file might be referenced
            urlMap.set(path, finalName);           // "folder/song.mp3" -> "song.mp3"
            urlMap.set('/' + path, finalName);     // "/folder/song.mp3" -> "song.mp3"
            urlMap.set('./' + path, finalName);    // "./folder/song.mp3" -> "song.mp3"
            urlMap.set(name, finalName);           // "song.mp3" -> "song.mp3"
            urlMap.set('/' + name, finalName);     // "/song.mp3" -> "song.mp3"
        }
    }

    // 2. Scan Code for External Audio/Images
    const externalUrls = new Set();
    for (const content of Object.values(codeFiles)) {
        const found = analyzer.scanForAssets(content);
        found.forEach(url => {
            // Ignore if already mapped or looks local
            if (!urlMap.has(url) && !url.startsWith('.') && !url.startsWith('/')) {
                externalUrls.add(url);
            }
        });
    }

    // 3. Download External & Recover Missing Assets
    if (externalUrls.size > 0) {
        const downloadPromises = Array.from(externalUrls).map(async (rawUrl) => {
            // Check if we already have it mapped from the main asset list (explicit assets)
            if (urlMap.has(rawUrl)) return;
            
            // Check if it's a local filename that we already have in staticFiles
            const cleanRaw = cleanName(rawUrl.split('/').pop());
            if (staticFiles[cleanRaw] || staticFiles[rawUrl]) {
                // Just map it
                const actualName = staticFiles[rawUrl] ? rawUrl : cleanRaw;
                urlMap.set(rawUrl, actualName);
                return;
            }

            // Attempt to determine the fetch URL
            let fetchUrl = rawUrl;
            let isRecovery = false;

            if (!rawUrl.match(/^https?:/)) {
                // It's a relative path (e.g. "snake_eat.mp3") that wasn't in the asset list.
                // Try to recover it from WebSim CDN.
                const filename = rawUrl.split('/').pop();
                if (projectMeta && projectMeta.project && projectMeta.project.id) {
                    const ts = Date.now();
                    // WebSim CDN pattern
                    fetchUrl = `https://${projectMeta.project.id}.c.websim.com/${encodeURIComponent(filename)}?v=${projectMeta.project.current_version || '1'}&t=${ts}`;
                    isRecovery = true;
                    console.log(`[Generator] Attempting to recover missing asset: ${rawUrl} -> ${fetchUrl}`);
                } else {
                    return; // Can't recover without project ID
                }
            }

            try {
                const res = await fetch(fetchUrl);
                
                let blob;
                if (!res.ok) {
                    if (isRecovery) {
                        console.warn(`[Generator] Recovery failed for ${rawUrl} (404). Using empty placeholder.`);
                        // Use silent placeholder to prevent DOMException / Game Crash
                        if (rawUrl.match(/\.(mp3|wav|ogg)$/i)) blob = EMPTY_WAV;
                        else if (rawUrl.match(/\.(png|jpg|jpeg)$/i)) blob = EMPTY_PNG;
                        else return;
                    } else {
                        return;
                    }
                } else {
                    blob = await res.arrayBuffer();
                }

                // Verify content type to avoid saving HTML 404 pages as assets
                if (!isRecovery && res.headers) {
                    const type = res.headers.get('content-type');
                    if (type && type.includes('text/html')) {
                         console.warn(`[Generator] Asset ${rawUrl} returned HTML. Ignoring.`);
                         return;
                    }
                }

                let name = rawUrl.split('/').pop().split('?')[0];
                if (!name || name.length > 50) name = 'asset';
                
                const clean = cleanName(name);
                let finalName = clean;
                let counter = 1;
                while (staticFiles[finalName]) {
                    const parts = clean.split('.');
                    const ext = parts.pop();
                    const base = parts.join('.');
                    finalName = `${base}_${counter}.${ext}`;
                    counter++;
                }

                // If recovered, we MUST map the original relative string to this new file
                // so processJS can rewrite "snake_eat.mp3" -> "snake-eat.mp3"
                if (blob instanceof Uint8Array) staticFiles[finalName] = blob;
                else staticFiles[finalName] = new Uint8Array(blob);

                urlMap.set(rawUrl, finalName);
                // Also map the filename itself just in case
                if (rawUrl !== name) urlMap.set(name, finalName);

            } catch (e) {
                console.warn("Failed to download external asset:", rawUrl, e);
                // Fallback for audio to prevent crash
                if (rawUrl.match(/\.(mp3|wav|ogg)$/i)) {
                    let name = rawUrl.split('/').pop().split('?')[0];
                    const clean = cleanName(name);
                    staticFiles[clean] = EMPTY_WAV;
                    urlMap.set(rawUrl, clean);
                }
            }
        });
        
        await Promise.all(downloadPromises);
    }

    analyzer.setExternalMap(urlMap);

    // 4. Process Code Files
    const clientFiles = {};

    // Entrypoint Configuration
    let entrypoints = null; // Default handled in config.js if null
    let viteInputs = {};

    if (launchMode === 'expanded') {
        const launcherHtml = generateLauncherHtml(projectTitle, projectMeta.project.thumbnail_url);
        clientFiles['launcher.html'] = launcherHtml;

        // Configure Vite Multi-Page App
        viteInputs = {
            default: 'launcher.html',
            game: 'index.html'
        };

        // Configure Devvit Entrypoints
        entrypoints = {
            "default": {
                "entry": "launcher.html",
                "height": "regular", 
                "inline": true
            },
            "game": {
                "entry": "index.html",
                "height": "tall"
            }
        };
    }
    
    for (const [path, content] of Object.entries(codeFiles)) {
        if (/\.(js|mjs|ts|jsx|tsx)$/i.test(path)) {
            clientFiles[path] = analyzer.processJS(content, path);
        } else if (path.endsWith('.html')) {
            const { html, extractedScripts } = analyzer.processHTML(content, path.split('/').pop());
            clientFiles[path] = html;
            
            extractedScripts.forEach(script => {
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${script.filename}` : script.filename;
                clientFiles[fullPath] = script.content;
            });
        } else if (path.endsWith('.css')) {
            clientFiles[path] = analyzer.processCSS(content, path);
        } else {
            clientFiles[path] = content;
        }
    }

    // 2. Configs
    const hasRemotion = !!analyzer.dependencies['remotion'];
    let hasReact = hasRemotion || !!analyzer.dependencies['react'];
    const hasTailwind = analyzer.hasTailwind;

    // Final check for React if not caught by dependency analysis (handles inline scripts)
    if (!hasReact) {
        for (const content of Object.values(clientFiles)) {
            const code = (content instanceof Uint8Array) ? new TextDecoder().decode(content) : String(content);
            if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
                hasReact = true;
                break;
            }
        }
    }

    const extraDevDeps = {};
    if (hasReact) {
        extraDevDeps['@vitejs/plugin-react'] = '^4.2.0';
        extraDevDeps['@babel/core'] = '^7.23.0';
        extraDevDeps['@babel/preset-react'] = '^7.23.0';
    }

    if (hasTailwind) {
        extraDevDeps['tailwindcss'] = '^3.4.0';
        extraDevDeps['postcss'] = '^8.4.0';
        extraDevDeps['autoprefixer'] = '^10.4.0';
        
        // Place config files in src/client so Vite/PostCSS can find them during build:client
        zip.file("src/client/tailwind.config.js", `
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html", 
    "./*.{js,ts,jsx,tsx}", 
    "./**/*.{js,ts,jsx,tsx}"
  ],
  theme: { extend: {} },
  plugins: [],
}`.trim());
        
        zip.file("src/client/postcss.config.js", `
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}`.trim());

        // Prepend tailwind directives to the first found CSS file
        let cssFound = false;
        for (const path of Object.keys(clientFiles)) {
            if (path.endsWith('.css')) {
                clientFiles[path] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n` + clientFiles[path];
                cssFound = true;
                break;
            }
        }

        // If no CSS file exists, create one and inject it to ensure Tailwind base styles load
        if (!cssFound) {
            const cssPath = 'tailwind_generated.css';
            clientFiles[cssPath] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`;
            
            // Find index.html to inject the link
            const indexPath = Object.keys(clientFiles).find(p => p.endsWith('index.html'));
            if (indexPath) {
                let htmlContent = clientFiles[indexPath];
                if (htmlContent instanceof Uint8Array) {
                    htmlContent = new TextDecoder().decode(htmlContent);
                }
                
                // Only inject if not already present
                if (!htmlContent.includes(cssPath)) {
                    // Try to inject before </head>, fallback to body
                    if (htmlContent.includes('</head>')) {
                        htmlContent = htmlContent.replace('</head>', `<link rel="stylesheet" href="./${cssPath}">\n</head>`);
                    } else {
                        htmlContent = `<link rel="stylesheet" href="./${cssPath}">\n` + htmlContent;
                    }
                    clientFiles[indexPath] = htmlContent;
                }
            }
        }
    }

    zip.file("package.json", generatePackageJson(projectSlug, analyzer.dependencies, extraDevDeps));
    zip.file("devvit.json", generateDevvitJson(projectSlug, entrypoints));
    zip.file("tsconfig.json", tsConfig);
    zip.file(".gitignore", "node_modules\n.devvit\ndist"); 

    if (includeReadme) {
        zip.file("README.md", generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`));
    }

    zip.file("scripts/setup.js", setupScript);
    zip.file("scripts/validate.js", validateScript);

    // 3. Client Folder (src/client)
    const srcFolder = zip.folder("src");
    const clientFolder = srcFolder.folder("client");
    
    clientFolder.file("vite.config.ts", generateClientViteConfig({ hasReact, hasRemotion, inputs: viteInputs }));

    // Write processed code
    for (const [path, content] of Object.entries(clientFiles)) {
        clientFolder.file(path, content);
    }

    // Write static assets to src/client/public
    // Vite will copy these to dist/client root
    if (Object.keys(staticFiles).length > 0) {
        const publicFolder = clientFolder.folder("public");
        for (const [name, content] of Object.entries(staticFiles)) {
            publicFolder.file(name, content);
        }
    }

    // Polyfills in src/client
    
    // Generate Global Shims for CDN packages
    let shimCode = '';
    if (analyzer.globalShims.size > 0) {
        shimCode += '// Global Shims for CDN libraries\n';
        if (analyzer.globalShims.has('react')) shimCode += "import React from 'react'; window.React = React;\n";
        if (analyzer.globalShims.has('react-dom')) shimCode += "import ReactDOM from 'react-dom'; window.ReactDOM = ReactDOM;\n";
        if (analyzer.globalShims.has('three')) shimCode += "import * as THREE from 'three'; window.THREE = THREE;\n";
        if (analyzer.globalShims.has('jquery')) shimCode += "import $ from 'jquery'; window.$ = window.jQuery = $;\n";
        if (analyzer.globalShims.has('pixi.js')) shimCode += "import * as PIXI from 'pixi.js'; window.PIXI = PIXI;\n";
        if (analyzer.globalShims.has('p5')) shimCode += "import p5 from 'p5'; window.p5 = p5;\n";
        shimCode += '\n';
    }

    // Prepare Polyfill Imports (Static) - hoisting import to top to avoid dynamic import issues
    let polyfillImports = "import { connectRealtime } from '@devvit/web/client';\nwindow.connectRealtime = connectRealtime;\n";
    
    // Combine
    const combinedPolyfills = [polyfillImports, shimCode, simpleLoggerJs, webAudioPolyfill, websimSocketPolyfill, websimStubsJs, avatarInjector].join('\n\n');
    clientFolder.file("websim_polyfills.js", combinedPolyfills);
    clientFolder.file("websim_package.js", websimPackageJs);
    clientFolder.file("jsx-dev-proxy.js", jsxDevProxy);
    clientFolder.file("protobuf-inquire-stub.js", protobufInquireStub);

    if (hasRemotion) {
        clientFolder.file("remotion_bridge.js", `
export * from 'remotion';
export { Player } from '@remotion/player';
        `.trim());
    }

    // 4. Server Folder (src/server)
    const serverFolder = srcFolder.folder("server");
    serverFolder.file("index.ts", getMainTs(projectTitle));
    serverFolder.file("vite.config.ts", generateServerViteConfig());
    
    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip` };
}

