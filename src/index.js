'use strict';

const fs = require('fs');
const path = require('path');
const URL = require('url');
const snoowrap = require('snoowrap');
const Gfycat = require('gfycat-sdk');
const request = require('request-promise-native');
const Config = require('./utils/config');
const log = require('./utils/log');

const c = new Config();
const PROD = c.PROD;

const reddit = new snoowrap({
    userAgent: c.userAgent,
    clientId: c.reddit.clientId,
    clientSecret: c.reddit.clientSecret,
    username: c.reddit.username,
    password: c.reddit.password
});
reddit.config({
    retryErrorCodes: [], // Disable automatic retry to not spam reddit since we loop anyways
    maxRetryAttempts: 0, // Since the above thing doesn't seem to work
    warnings: !PROD,
    requestTimeout: 15000
});
const gfycat = new Gfycat({
    clientId: c.gfycat.clientId,
    clientSecret: c.gfycat.clientSecret
});
if (!PROD) gfycat.apiVersion = '/v1test';

let loopInterval;
let lastPost = undefined;
let loops = 0; // keep track of loops here to regulary persist stats/cache
let deferredPosts = [];

log('[anti-gif-bot] Ready.');

module.exports.start = () => {
    if (!loopInterval) {
        log('[anti-gif-bot] Started.');
        loopInterval = setInterval(update, c.updateInterval);
        update();
    }
};
module.exports.stop = () => {
    if (loopInterval) {
        log('[anti-gif-bot] Stopped.');
        clearInterval(loopInterval);
        loopInterval = null;
    }
};
module.exports.start(); // I'll change the structure a bit in the future so I already extracted the start function


// TODO Tenor has mp4s as well but only accessible via their API: https://www.tenor.co/gifapi
// Problem though: I don't know the gif ID which I need to request the info.
// The direct gif links only contain the file SHA1 (?) which doesn't seem to be any useful.

async function update() {

    /* TODO stats about:
     Gif too small
     Not a gif link
     mp4 not available (mainly giphy, sometimes tumblr)
     Broken link
     Already on gfycat
     gfycat upload time (with stages)
     Total gif/mp4 sizes
     Average gif/mp4 sizes
     Average size save
     mp4 bigger
     Size save by hoster
     Post deleted
     Post frequency (per interval, sub?)
     NSFW frequency / count?

     I will move the stats to a DB since they're just way too much for some JSON.
     Firebase looks good for that since it's not *that* much data (and it's free).
     */

    try {

        loops++;
        c.stats.onLoop();
        const submissions = await reddit.getNew('all', { // new posts in /r/all
            limit: 100, // maximum per API guidelines
            show: 'all', // disable some filters
            before: lastPost
        });

        c.stats.onSubmissions(submissions.length);
        if (submissions.length > 0) {
            lastPost = submissions[0].name;
        } else {
            throw new Error('No items returned by Reddit, skipping loop');
        }
        const sorted = [];
        submissions.forEach(post => {
            const url = post.url;
            const jsUrl = URL.parse(url);
            jsUrl.search = null;
            jsUrl.hash = null;
            const baseUrl = URL.format(jsUrl);
            const nsfw = post.over_18;
            const subreddit = post.subreddit.display_name;
            const domain = post.domain;
            const isSelfPost = domain.startsWith('self.');
            const isGif = baseUrl.endsWith('.gif');
            const isMp4 = baseUrl.endsWith('.mp4');
            const ignoredDomain = includesPartial(c.ignoreDomains, domain);
            const ignoredSubreddit = c.ignoreSubreddits.includes(subreddit) ||
                includesPartial(c.ignoreSubredditsPartial, subreddit);
            const isInKnownDomains = includesPartial(c.knownDomains, domain);
            const isInNonDotGifDomains = linkMatchesConfig(c.nonDotGifDomains, domain, url);
            const isKnownDomain = isInKnownDomains || isInNonDotGifDomains;

            if (!isSelfPost && !nsfw && !isMp4) {
                if ((isInKnownDomains && isGif) || isInNonDotGifDomains || isGif) {
                    c.stats.onGif(url);
                    c.stats.onSubreddit(subreddit);
                    if (isKnownDomain) {
                        c.stats.onDomain(domain);
                    } else {
                        c.stats.onUnknownDomain(domain);
                    }
                    if (!ignoredDomain && !ignoredSubreddit) {
                        sorted.push({
                            submission: post,
                            nsfw: nsfw,
                            subreddit: subreddit,
                            author: post.author.name,
                            baseUrl: baseUrl,
                            url: url,
                            domain: domain,
                            gif: linkToGifLink(baseUrl.endsWith('/') ? baseUrl.substring(0, url.length - 1) : baseUrl,
                                domain), // Already convert html link to direct gif links (giphy)
                            mp4: undefined,
                            deferCount: 0,
                            deferred: false,
                            uploading: false,
                            uploaded: false,
                            gifSize: undefined,
                            mp4Size: undefined,
                            webmSize: undefined,
                            mp4Save: undefined,
                            webmSave: undefined
                        });
                    } else {
                        if (!PROD) log(`Ignoring gif; ignored domain: ${ignoredDomain} (${domain}); ignored sureddit: ${ignoredSubreddit} (${subreddit})`);
                    }
                }
            }
        });
        let posts = sorted;
        c.stats.onGifCount(posts.length);
        posts = posts.concat(deferredPosts);
        deferredPosts = [];

        // Handle them all async in parallel
        await Promise.all(posts.map((post) => {
            return parsePost(post)
        }));

        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const link = post.mp4;
            if (!link && post.deferred) {

                deferredPosts.push(post);

            } else if (link) {
                try {
                    const gfycatLink = /^https?:\/\/gfycat.com/.test(link);
                    const mp4Bigger = post.mp4Save < 1;
                    const templates = c.replyTemplates;
                    const allParts = templates.textParts;
                    const parts = Object.assign({}, allParts.default, allParts[post.subreddit]);
                    let reply = templates.baseReply.join('');
                    let content = '';
                    reply = reply.replace('{{type}}', post.uploaded ? 'mirror' : 'link')
                        .replace('{{mp4link}}', link)
                        .replace('{{botversion}}', c.botVersion);

                    if (!mp4Bigger) {
                        content = parts.sizetext;
                        if (post.webmSize) {
                            content += parts.webmsizetext;
                        }
                    } else {
                        content = parts.mp4biggertext;
                        if (gfycatLink) {
                            content += parts.gfycatbiggertext;
                        }
                    }
                    if (parts.bonusline) {
                        content += parts.bonusline;
                    }
                    content = content
                        .replace('{{mp4sizecomp}}', toFixedFixed(post.mp4Save))
                        .replace('{{webmsizecomp}}', toFixedFixed(post.webmSave))
                        .replace('{{gifsize}}', getReadableFileSize(post.gifSize))
                        .replace('{{mp4size}}', getReadableFileSize(post.mp4Size))
                        .replace('{{webmsize}}', getReadableFileSize(post.webmSize));

                    reply = reply.replace('{{content}}', content);

                    if (PROD) {
                        await post.submission.reply(reply);
                    } else {
                        log(reply);
                    }
                } catch (e) {
                    if (e.toString().includes('403'))
                        c.stats.onPossibleBanError(e, post.subreddit);
                    else
                        c.stats.onLoopError(e);
                }
            }
        }

    } catch (e) {
        c.stats.onLoopError(e);
    }

    if (!PROD || loops % c.saveInterval === 0) {
        c.stats.save();
        c.cache.save();
    }

}

async function parsePost(post) {

    try {

        const domain = post.domain;
        const gif = post.gif;
        if (!PROD) {
            log();
            log(`Got post by: ${post.author} in ${post.subreddit}`);
            log(`Url: ${post.url}`);
            log(`Gif: ${post.gif}`);
            log(`mp4: ${post.mp4}`);
            log(`Deferred: ${post.deferred}`);
            log(`Defer count: ${post.deferCount}`);
            log(`Uploading: ${post.uploading}`);
            log(`Uploaded: ${post.uploaded}`);
            const tempSubmission = post.submission;
            post.submission = undefined; // Don't log the huge submission object
            log(JSON.stringify(post));
            post.submission = tempSubmission;
            log();
        }
        let link = post.mp4;
        let skipToEnd = false;
        let cacheItem;

        if (post.uploading || link) { // Currently uploading or already uploaded and passed to this loop
            skipToEnd = true;
        } else if (!post.uploaded && !link) {
            cacheItem = c.cache.getCacheItem(gif);
            link = cacheItem ? cacheItem.mp4 : null;
        }
        if (!post.uploaded && link && link !== 'https://i.giphy.com.mp4' && !link.endsWith('..mp4')) { // Already cached (additional checks because of previous parsing bugs)
            post.mp4 = link;
            post.gifSize = cacheItem.gifSize;
            post.mp4Size = cacheItem.mp4Size;
            post.webmSize = cacheItem.webmSize;
            post.uploaded = cacheItem.uploaded;
            c.stats.onCachedGif(gif, link);
            calculateSaves(post);
            return;
        }
        if (post.author === '[deleted]') {
            post.deferred = false;
            if (!PROD) log('Ignoring post since it got deleted');
            return; // If post got deleted during deferral just ignore it
        }

        if (!skipToEnd) {

            if (!post.deferred) {
                const gifCheck = await checkUrl(gif, 'image/gif', true);
                post.gifCheck = gifCheck;
                post.gifSize = gifCheck.size;
                if (!gifCheck.success) {
                    if (gifCheck.statusCodeOk) { // Ignore if not found at all
                        if (!gifCheck.rightType) {
                            if (!PROD) log(`Not a gif link: ${post.url}`);
                        } else if (gifCheck.size === -1) {
                            prepareAndUploadPost(post); // Size unknown; it's an unknown hoster anyways since others send a content-length
                        } else {
                            if (!PROD) log(`Gif too small (and not deferred), skipping (size: ${gifCheck.size})`);
                        }
                    } else {
                        if (!PROD) log(`Not a working link, got status code ${gifCheck.statusCode}: ${post.url}`);
                    }
                    return;
                }
            }

            link = await createMp4Link(post, gif, domain);
            if (!link) {
                if (domain.includes('i.redd.it')) {
                    // defer loading posts from i.redd.it to avoid an issue where the 'preview' item isn't
                    // yet loaded in the post (probably takes time to process)
                    if (!defer(post, gif, c.redditMp4DeferCount)) {
                        prepareAndUploadPost(post);
                    }
                    return;
                } else {
                    // upload to gfycat async
                    prepareAndUploadPost(post);
                    return;
                }
            }

        }

        if (!link) {
            if (!PROD) log(`No link gotten for ${gif}`);
            return;
        }

        const gfycatLink = /^https?:\/\/gfycat.com/.test(link);
        if (gfycatLink) {
            await gfycat.authenticate();
            const res = await gfycat.getGifDetails({
                gfyId: link.substring(link.lastIndexOf('/') + 1)
            });
            post.mp4Size = res.gfyItem.mp4Size;
            post.webmSize = res.gfyItem.webmSize;
            if (!post.gifSize) {
                post.gifSize = res.gfyItem.gifSize;
            }
        } else {
            const mp4Check = await checkUrl(link, 'video/mp4', false);
            if (!mp4Check.success) {
                // defer loading to give giphy/tumblr a bit of time to create an mp4
                if (!defer(post, gif, c.generalMp4DeferCount)) {
                    prepareAndUploadPost(post);
                }
                return;
            }
            post.mp4Size = mp4Check.size;
        }
        calculateSaves(post);

        post.mp4 = link;
        c.cache.addCacheItem(post);

    } catch (e) {
        c.stats.onLoopError(e);
    }

}

function linkToGifLink(gif, domain) {
    let link = gif;
    if (domain.includes('giphy.com')) {
        if (domain.startsWith('media')) {
            link = gif.substring(0, gif.lastIndexOf('/')).replace(/[a-z0-9]+(\.giphy.com\/media)/, 'i.giphy.com') + '.gif';
        } else if (!domain.startsWith('i.')) { // If it starts with 'i.' it's already the direct gif link
            // actual website giphy.com
            link = gif.replace(/(www\.)?giphy.com\/gifs/, 'i.giphy.com');
            if (link.lastIndexOf('/') > link.length - 12) {
                // IDs are 13 in length, if the last / is further back than that there's something else appended
                // (such as '/html5', '/tile', '/fullscreen')
                link = link.substring(0, link.lastIndexOf('/'));
            }
            const dashIndex = link.lastIndexOf('-');
            if (dashIndex > 0) {
                const slashIndex = link.lastIndexOf('/');
                link = link.substring(0, slashIndex + 1) + link.substring(dashIndex + 1);
            }
            link += '.gif';
        }
    }
    return link;
}

async function createMp4Link(post, gif, domain) {
    let link;

    if (domain.includes('i.gyazo.com') || domain.includes('media.tumblr.com') || domain.includes('i.makeagif.com') ||
        domain.includes('j.gifs.com') || domain.includes('gifgif.io') || domain.includes('giphy.com')) { // Giphy because we already converted it before

        link = replaceGifWithMp4(gif);

    } else if (domain.includes('gfycat.com')) {

        link = gif.replace(/(thumbs\.)|(giant\.)/, '').replace(/(-size_restricted)?(\.gif)$/, '');

    } else if (domain.includes('i.redd.it')) {

        try {
            post.submission = await post.submission.refresh(); // Refresh since post object is the same as before deferral
            link = post.submission.preview.images[0].variants.mp4.source.url; // JSON hell
        } catch (e) {
        }

    }
    return link;
}

async function checkUrl(url, filetype, checksize) {
    const result = {
        success: false,
        size: -1,
        statusCode: 0,
        statusCodeOk: false,
        type: null,
        rightType: false,
        aboveSizeThreshold: false
    };
    try {
        const res = await request({
            method: 'HEAD',
            uri: url,
            resolveWithFullResponse: true, // get full response instead of body
            simple: false // don't throw on error code
        });
        result.statusCode = res.statusCode;
        result.statusCodeOk = res.statusCode >= 200 && res.statusCode < 400;
        result.size = res.caseless.get('content-length') || -1;
        result.success = true;
        result.type = res.caseless.get('content-type');
        result.rightType = result.type === filetype;
        result.aboveSizeThreshold = checksize ? result.size > c.gifSizeThreshold : true;
        if (!result.statusCodeOk) {
            result.success = false;
        } else if (filetype) {
            result.success = result.rightType && result.aboveSizeThreshold;
        }
        if (!PROD) {
            log(`Checked ${url}`);
            log(JSON.stringify(result));
        }
    } catch (e) {
        c.stats.onLoopError(e);
    }
    return result;
}

async function uploadPost(post) {
    if (!PROD) {
        const time = 5000 + Math.random() * 40000;
        log(`waiting with fake upload for ${time}`);
        await delay(time);
        log(`Not uploading ${post.url}`);
        post.mp4 = 'https://gfycat.com/UncomfortablePleasedAnemoneshrimp';
        post.uploading = false;
        post.uploaded = true;
        return;
    }
    try {
        const gif = post.url;
        let link = null;
        const postShortLink = `https://redd.it/${post.submission.id}`;

        await gfycat.authenticate();
        const uploadResult = await gfycat.upload({
            'fetchUrl': gif,
            'title': `Automatically uploaded gif from ${postShortLink} (by /u/${reddit.username})`,
            'nsfw': post.nsfw ? '1' : '0'
        });
        await delay(2000);
        while (link === null) {
            const result = await gfycat.checkUploadStatus(uploadResult.gfyname);
            if (result.task === 'encoding') {
                await delay(2000); // loop again after a delay
            } else if (result.task === 'complete') {
                link = `https://gfycat.com/${result.gfyname}`;
            } else {
                throw new Error(`Gfycat error: ${result.task}`);
            }
        }
        c.stats.onUpload(gif, link);
        post.mp4 = link;
        if (link)
            c.cache.addCacheItem(post);
        post.uploading = false;
        post.uploaded = true;
    } catch (e) {
        c.stats.onLoopError(e);
        post.uploading = false;
        post.uploaded = true;
        post.deferred = false;
    }
}

function defer(post, gif, count) {
    if (post.deferCount < count) {
        post.deferCount++;
        post.deferred = true;
        c.stats.onDefer(gif);
        return true;
    }
    post.deferred = false;
    c.stats.onDeferFail(gif);
    return false;
}

function prepareAndUploadPost(post) {
    if (!post.uploading && !post.uploaded) {
        post.deferred = true;
        post.uploading = true;
        uploadPost(post);
    }
}

function getReadableFileSize(bytes) {
    // I'm waiting for Yottabyte-sized gifs
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB (Exabyte)', 'ZB (Zettayte)',
        'YB (Yottabyte)', 'XB (Xenottabyte)', 'SB (Shilentnobyte)', 'DB (Domegemegrottebyte)',
        'IB (Icosebyte)', 'MB (Monoicosebyte)', 'DB (Diemuxbyte), AB (Andrebyte)',
        'mb (mbbyte. Not megabyte. The larger one. 1e+45 bytes.)'];
    // 1e45 is 2907354897182427562197295231552018137414565442749272241125960796722557152453591693304764202855054262243050086425064711734138406514458624 bytes.
    // 2.907.354.897.182.427.562.197.295.231.552.018.137.414.565.442.749.272.241.125.960.796.722.557.152.453.591.693.304.764.202.855.054.262.243.050.086.425.064.711.734.138.406.514.458.624 fucking bytes.
    let i = 0;
    while (bytes > 1024 && i < sizes.length - 1) {
        i++;
        bytes /= 1024;
    }
    return `${toFixedFixed(bytes)} ${sizes[i]}`;
}

function calculateSaves(post) {
    post.mp4Save = (post.gifSize / post.mp4Size);
    if (post.webmSize)
        post.webmSave = (post.gifSize / post.webmSize);
    if (!PROD) log(`Link stats: mp4 size: ${post.mp4Size} (webm: ${post.webmSize});
         that is 1/${post.mp4Save} times (webm: ${post.webmSave})`);
}

function toFixedFixed(num, decimals = 2) {
    decimals = Math.pow(10, decimals);
    return Math.round(num * decimals) / decimals;
}

function replaceGifWithMp4(url) {
    return url.substring(0, url.lastIndexOf('.')) + '.mp4';
}

function includesPartial(array, term) {
    term = term.toUpperCase();
    for (let i = 0; i < array.length; i++) {
        const item = array[i].toUpperCase();
        if (item.includes(term) || term.includes(item))
            return true;
    }
    return false;
}

function linkMatchesConfig(config, domain, link) {
    const conf = config[domain];
    if (conf)
        if (new RegExp(conf, 'i').test(link))
            return true;
    return false;
}

function delay(delay) {
    return new Promise(r => setTimeout(r, delay));
}