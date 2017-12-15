'use strict';

const path = require('path');
const fs = require('fs');
const pkgReader = require('./package-reader');
const Stats = require('./stats');
const LinkCache = require('./link-cache');

class Config {

    constructor() {
        this.configPath = path.join(__dirname, '..', 'json', 'config.json');
        this.newConfigPath = path.join(__dirname, '..', 'json', 'newconfig.json');
        this.cachePath = path.join(__dirname, '..', 'json', 'linkCache.json');
        this.statsPath = path.join(__dirname, '..', 'json', 'stats.json');
        this.secretPath = path.join(__dirname, '..', '..', '.secret');
        this.prod = process.env.PROD || false;
        this.load();
        setInterval(this.checkForUpdates.bind(this), 1000 * 60);
    }

    load() {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.keys = JSON.parse(fs.readFileSync(path.join(this.secretPath, 'keys.json'), 'utf8'));
    }

    save() {
        fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), (e) => {
            if (e) logger.error('Error saving config', e);
        });
    }

    checkForUpdates() {
        if (fs.existsSync(this.newConfigPath)) {
            logger.infolog('New config detected, reloading.');
            try {
                this.config = JSON.parse(fs.readFileSync(this.newConfigPath, 'utf8'));
                this.save();
                fs.unlinkSync(this.newConfigPath);
                if (this.lkc) {
                    this.lkc.save();
                    this.lkc = null;
                    this.cache; // Reinit link cache in case the sizes changed
                }
            } catch (e) {
                logger.error('An error occurred while loading the new config', e);
            }
        }
    }

    get reddit() {
        return this.keys.reddit;
    }

    get gfycat() {
        return this.keys.gfycat;
    }

    get stats() {
        if (!this.sts) {
            this.sts = new Stats(this.statsPath);
        }
        return this.sts;
    }

    get cache() {
        if (!this.lkc) {
            this.lkc = new LinkCache(this.cachePath, this.stats, this.cacheSize, this.cachePurgeSize);
        }
        return this.lkc;
    }


    get updateInterval() {
        return this.config.updateInterval;
    }

    get saveInterval() {
        return this.config.saveInterval;
    }

    get cacheSize() {
        return this.config.cacheSize;
    }

    get cachePurgeSize() {
        return this.config.cachePurgeSize;
    }

    get gifSizeThreshold() {
        return this.config.gifSizeThreshold;
    }

    get redditMp4DeferCount() {
        return this.config.redditMp4DeferCount;
    }

    get generalMp4DeferCount() {
        return this.config.generalMp4DeferCount;
    }

    get replyTemplates() {
        return this.config.replyTemplates;
    }

    get knownDomains() {
        return this.config.knownDomains;
    }

    get nonDotGifDomains() {
        return this.config.nonDotGifDomains;
    }

    get ignoreDomains() {
        return this.config.ignoreDomains;
    }

    get mp4CanBeBiggerDomains() {
        return this.config.mp4CanBeBiggerDomains;
    }

    get ignoreSubreddits() {
        return this.config.ignoreSubreddits;
    }

    get ignoreSubredditsPartial() {
        return this.config.ignoreSubredditsPartial;
    }


    get userAgent() {
        return `bot:anti-gif-bot:${this.botVersion}:/u/MrWasdennnoch`;
    }

    get botVersion() {
        return pkgReader.version;
    }

    get PROD() {
        return this.prod;
    }

}
module.exports = Config;