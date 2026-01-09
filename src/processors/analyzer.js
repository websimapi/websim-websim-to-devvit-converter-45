import { uint8ToString } from './utils.js';
import { normalizeImport } from './imports.js';
import { processJS } from './js.js';
import { processHTML } from './html.js';
import { processCSS } from './css.js';

// --- Asset Analyzer & Rewriter (Vite Logic) ---

export class AssetAnalyzer {
    constructor() {
        this.dependencies = {};
        this.globalShims = new Set();
        this.hasTailwind = false;
        this.urlMap = new Map();
    }

    setExternalMap(map) {
        this.urlMap = map;
    }

    scanForAssets(content) {
        const code = uint8ToString(content);
        const urls = new Set();
        // Look for URLs OR relative paths with media extensions in quotes
        // We catch both "https://..." and "asset.mp3" to handle missing implicit assets
        const regex = /["']([^"'\n\(\)]+\.(mp3|wav|ogg|flac|aac|png|jpg|jpeg|gif|glb|gltf))["']/gi;
        let match;
        while ((match = regex.exec(code)) !== null) {
            const url = match[1];
            if (url && !url.startsWith('data:')) {
                urls.add(url);
            }
        }
        return Array.from(urls);
    }

    normalizeImport(source) {
        return normalizeImport(source, this.dependencies);
    }

    processJS(jsContent, filename) {
        return processJS(jsContent, filename, this);
    }

    processHTML(htmlContent, filename) {
        return processHTML(htmlContent, filename, this);
    }

    processCSS(cssContent, filename) {
        return processCSS(cssContent, filename);
    }
}