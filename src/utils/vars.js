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

const botVersion = pkgReader.getVersion();
const userAgent = `bot:anti-gif-bot:${botVersion}`;
const prod = process.env.PROD || false;
const log = !prod;

const stats = new Stats(statsPath, log);
const cache = new LinkCache(cachePath, stats, config.cacheSize, config.cachePurgeSize);


exports.reddit = keys.reddit;
exports.gfycat = keys.gfycat;
exports.updateInterval = config.updateInterval;
exports.gifSizeThreshold = config.gifSizeThreshold;
exports.ignoreDomains = config.ignoreDomains;
exports.ignoreSubreddits = config.ignoreSubreddits;
exports.ignoreSubredditsPartial = config.ignoreSubredditsPartial;
exports.knownDomains = config.knownDomains;
exports.nonDotGifDomains = config.nonDotGifDomains;
exports.saveInterval = config.saveInterval;
exports.replyTemplates = config.replyTemplates;

exports.botVersion = botVersion;
exports.userAgent = userAgent;
exports.prod = prod;
exports.log = log;
exports.stats = stats;
exports.cache = cache;