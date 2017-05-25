'use strict';

const fs = require('fs');

class LinkCache {

    constructor(savePath, stats, maxSize, purgeAmount) {
        this.path = savePath;
        this.stats = stats;
        this.maxSize = maxSize;
        this.purgeAmount = purgeAmount;
        this.version = 5;
        this.load();
    }

    load() {
        let json = {
            version: 0,
            imageCache: []
        };
        Object.assign(json, JSON.parse(fs.readFileSync(this.path, {encoding: 'utf8'}) || '{}'));
        this.imageCache = json.imageCache;
        if (json.version < this.version) {
            console.log(`[LinkCache] Version difference detected (cache: ${json.version}, current ${this.version}), upgrading cache...`);
            this.imageCache.forEach(item => {
                if (item.count === 1) item.count = undefined;
            });
            this.save();
        }
    }

    save() {
        if (this.imageCache.length > this.maxSize) {
            this.imageCache.splice(0, this.purgeAmount);
            this.stats.onCachePurge();
            this.stats.onCacheSizeChange(this.imageCache.length);
        }
        const json = {
            version: this.version,
            imageCache: this.imageCache
        };
        fs.writeFile(this.path, JSON.stringify(json, null, 2), (e) => {
            if (e) console.log(`[!]-- Error saving cache: ${e.toString()}`);
        });
    }

    getCacheItem(gif) {
        for (let i = 0; i < this.imageCache.length; i++) {
            const item = this.imageCache[i];
            if (item.gif === gif) {
                if (item.count === undefined)
                    item.count = 1;
                item.count++;
                if (item.uploaded === undefined)
                    item.uploaded = false;
                return item;
            }
        }
        return null;
    }

    addCacheItem(post) {
        // Set some unnecessary items to undefined to not save them in the JSON (makes it a bit smaller)
        this.imageCache.push({
            gif: post.gif,
            mp4: post.mp4,
            gifSize: +post.gifSize,
            mp4Size: +post.mp4Size,
            webmSize: post.webmSize !== undefined ? +post.webmSize : undefined,
            uploaded: post.uploaded ? true : undefined
        });
        this.stats.onCacheSizeChange(this.imageCache.length);
    }

}

module.exports = LinkCache;