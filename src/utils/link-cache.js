'use strict';

const fs = require('fs');

class LinkCache {

    constructor(savePath, stats, maxSize, purgeAmount) {
        this.path = savePath;
        this.stats = stats;
        this.maxSize = maxSize;
        this.purgeAmount = purgeAmount;
        this.load();
    }

    load() {
        let json = {
            imageCache: []
        };
        Object.assign(json, JSON.parse(fs.readFileSync(this.path, {encoding: 'utf8'}) || '{}'));
        this.imageCache = json.imageCache;
    }

    save() {
        if (this.imageCache.length > this.maxSize) {
            this.imageCache.splice(0, this.purgeAmount);
            this.stats.onCachePurge();
            this.stats.onCacheSizeChange(this.imageCache.length);
        }
        const json = {
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
                item.times.push(Date.now());
                return item;
            }
        }
        return null;
    }

    setCacheItem(gif, mp4, uploaded) {
        this.imageCache[gif] = mp4;
        this.imageCache.push({
            gif: gif,
            mp4: mp4,
            uploaded: uploaded,
            count: 1,
            times: [Date.now()]
        });
        this.stats.onCacheSizeChange(this.imageCache.length);
    }

}

module.exports = LinkCache;