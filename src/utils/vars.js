'use strict';

const fs = require('fs');
const path = require('path');
const pkgReader = require('../utils/package-reader');
const Stats = require('../utils/stats');
const LinkCache = require('../utils/link-cache');

const cachePath = path.join(__dirname, '..', 'json', 'linkCache.json');
const statsPath = path.join(__dirname, '..', 'json', 'stats.json');
const configPath = path.join(__dirname, '..', 'json', 'config.json');
const secretPath = path.join(__dirname, '..', '..', '.secret');
const keys = JSON.parse(fs.readFileSync(path.join(secretPath, 'keys.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const userAgent = `bot:anti-gif-bot:${pkgReader.getVersion()}`;
const prod = process.env.PROD || false;
const log = !prod;

const stats = new Stats(statsPath, log);
const cache = new LinkCache(cachePath, stats, config.cacheSize, config.cachePurgeSize);


module.exports.reddit = keys.reddit;
module.exports.gfycat = keys.gfycat;
module.exports.updateInterval = config.updateInterval;
module.exports.gifSizeThreshold = config.gifSizeThreshold;
module.exports.ignoreDomains = config.ignoreDomains;
module.exports.ignoreSubreddits = config.ignoreSubreddits;
module.exports.ignoreSubredditsPartial = config.ignoreSubredditsPartial;
module.exports.knownDomains = config.knownDomains;
module.exports.nonDotGifDomains = config.nonDotGifDomains;
module.exports.saveInterval = config.saveInterval;
module.exports.replyTemplates = config.replyTemplates;

module.exports.userAgent = userAgent;
module.exports.prod = prod;
module.exports.log = log;
module.exports.stats = stats;
module.exports.cache = cache;