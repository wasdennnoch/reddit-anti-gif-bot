'use strict';

const fs = require('fs');

class LinkCache {

    constructor(savePath, stats, maxSize, purgeAmount) {
        this.path = savePath;
        this.stats = stats;
        this.maxSize = maxSize;
        this.purgeAmount = purgeAmount;
        this.version = 3;
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
            for (let i = 0; i < this.imageCache.length; i++) {
                this.imageCache = [];
            }
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
                item.count++;
                return item;
            }
        }
        return null;
    }

    setCacheItem(post) {
        this.imageCache.push({
            gif: post.gif,
            mp4: post.mp4,
            gifSize: +post.gifSize,
            mp4Size: +post.mp4Size,
            webmSize: +post.webmSize,
            uploaded: post.uploaded,
            count: 1,
        });
        this.stats.onCacheSizeChange(this.imageCache.length);
    }

}

module.exports = LinkCache;