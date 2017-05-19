'use strict';

const fs = require('fs');
const path = require('path');
const snoowrap = require('snoowrap');
const Gfycat = require('gfycat-sdk');
const request = require('request-promise-native');
const deasync = require('deasync');
const vars = require('./utils/vars');

const PROD = vars.prod;

const stats = vars.stats;
const cache = vars.cache;
const userAgent = vars.userAgent;
const reddit = new snoowrap({
    userAgent: userAgent,
    clientId: vars.reddit.clientId,
    clientSecret: vars.reddit.clientSecret,
    username: vars.reddit.username,
    password: vars.reddit.password
});
reddit.config({
    retryErrorCodes: [], // Disable automatic retry to not spam reddit since we loop anyways,
    maxRetryAttempts: 0, // Since the above thing doesn't seem to work
    warnings: !PROD
});
const gfycat = new Gfycat({
    clientId: vars.gfycat.clientId,
    clientSecret: vars.gfycat.clientSecret
});
if (!PROD) gfycat.apiVersion = '/v1test';

let loopInterval;
let lastPost = undefined;
let loops = 0; // keep track of loops here to regulary persist stats/cache
let deferredPosts = [];

console.log('[anti-gif-bot] Ready.');

module.exports.start = () => {
    if (!loopInterval) {
        console.log('[anti-gif-bot] Started.');
        loopInterval = setInterval(update, vars.updateInterval);
        update();
    }
};
module.exports.stop = () => {
    if (loopInterval) {
        console.log('[anti-gif-bot] Stopped.');
        clearInterval(loopInterval);
        loopInterval = null;
    }
};
module.exports.start(); // I'll change the structure a bit in the future so I already extracted the start function


async function update() {

    /* TODO stats about:
     Gif too small
     Not a gif link
     mp4 not available (mainly giphy, sometimes tumblr)
     Broken link
     Already on gfycat
     Total gif/mp4 sizes
     Average gif/mp4 sizes
     Average size save
     Post deleted
     Post frequency (per interval, sub?)
     NSFW frequency / count?

     I will move the stats to a DB since they're just way too much for some JSON.
     Firebase looks good for that since it's not *that* much data (and it's free).
     */

    try {

        loops++;
        stats.onLoop();
        const submissions = await reddit.getNew('all', { // new posts in /r/all
            limit: 100, // maximum per API guidelines
            show: 'all', // disable some filters
            before: lastPost
        });

        stats.onSubmissions(submissions.length);
        if (submissions.length > 0) {
            lastPost = submissions[0].name;
        } else {
            throw new Error('No items returned by Reddit, skipping loop');
        }
        const sorted = [];
        submissions.forEach(post => {
            if (!post.domain.startsWith('self.') && !post.over_18 && !includesPartial(vars.ignoreDomains, post.domain)
                && !vars.ignoreSubreddits.includes(post.subreddit.display_name) && !includesPartial(vars.ignoreSubredditsPartial, post.subreddit.display_name)) {
                if ((includesPartial(vars.knownDomains, post.domain) && post.url.endsWith('.gif')) ||
                    (includesPartial(vars.nonDotGifDomains, post.domain) && !post.url.endsWith('.mp4')) || post.url.endsWith('.gif')) {
                    sorted.push(post);
                    stats.onGif(post.url);
                    // TODO always collect those stats and filter by blacklisted subs in dashboard
                    stats.onSubreddit(post.subreddit.display_name);
                    if (!includesPartial(vars.knownDomains, post.domain) && post.url.endsWith('.gif')) {
                        stats.onUnknownDomain(post.domain);
                    } else {
                        stats.onDomain(post.domain);
                    }
                }
            }
        });
        let posts = sorted;
        stats.onGifCount(posts.length);
        posts = posts.concat(deferredPosts);

        // Do them all async in parallel
        await Promise.all(posts.map((post) => {
            return parsePost(post)
        }));

        deferredPosts = [];
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const link = post.mp4link;
            if (!link && post.deferred) {

                deferredPosts.push(post);

            } else if (link) {
                try {
                    if (PROD) {
                        const reply = vars.replyTemplate.replace('%%MP4LINK%%', link).replace('%%TYPE%%', post.uploaded ? 'mirror' : 'link');
                        await post.reply(reply);
                    } else {
                        console.log(`Finished link, uploaded: ${post.uploaded}, link: ${link}`);
                    }
                } catch (e) {
                    if (e.toString().includes('403'))
                        stats.onPossibleBanError(e, post.subreddit.display_name);
                    else
                        throw e;
                }
            }
        }

    } catch (e) {
        stats.onLoopError(e);
    }

    if (!PROD || loops % vars.saveInterval === 0) {
        stats.save();
        cache.save();
    }

}

async function parsePost(post) {

    try {

        const domain = post.domain;
        let gif = post.url.endsWith('/') ? post.url.substring(0, post.url.length - 1) : post.url;
        gif = linkToGifLink(gif, domain); // Already convert html link to direct gif links (giphy)
        if (post.deferCount === undefined) { // only set the values if they've never been set (deferral)
            post.deferCount = 0;
            post.uploading = false;
            post.uploaded = false;
            post.deferred = false;
            post.result = {};
        }
        if (!PROD) {
            console.log();
            console.log(`Got post by: ${post.author.name}`);
            console.log(`Link: ${post.url}`);
            console.log(`Gif: ${gif}`);
            console.log(`mp4: ${post.mp4Link}`);
            console.log(`Deferred: ${post.deferred}`);
            console.log(`Defer count: ${post.deferCount}`);
            console.log(`Uploading: ${post.uploading}`);
            console.log(`Uploaded: ${post.uploaded}`);
            console.log(`Result: ${Object.keys(post.result).length === 0 ? "Empty" : JSON.stringify(post.result)}`);
            console.log();
        }
        let link = post.mp4link;
        let skipToEnd = false;
        let cacheItem;

        if (post.uploading || link) { // Currently uploading or already uploaded and passed to this loop
            skipToEnd = true;
        } else if (!post.uploaded && !link) {
            cacheItem = cache.getCacheItem(gif);
            link = cacheItem ? cacheItem.mp4 : null;
        }
        if (!post.uploaded && link && link !== 'https://i.giphy.com.mp4') { // Already cached (additional check because of previous parsing bug)
            post.mp4link = link;
            post.uploaded = cacheItem.uploaded;
            // TODO save and fetch sizes from cache
            // [rem] skipToEnd = true;
            stats.onCachedGif(gif, link);
            return;
        }
        if (post.author.name === '[deleted]') {
            post.deferred = false;
            if (!PROD) console.log('Ignoring post since it got deleted');
            return; // If post got deleted during deferral just ignore it
        }

        if (!skipToEnd) {

            if (!post.deferred) {
                const gifCheck = await checkUrl(gif, 'image/gif', true);
                post.result.gifCheck = gifCheck;
                post.result.gifSize = gifCheck.size;
                if (!gifCheck.success) {
                    if (gifCheck.statusCodeOk) { // Ignore if not found at all
                        if (gifCheck.wrongType) {
                            if (!PROD) console.log(`Not a gif link: ${post.url}`);
                        } else if (gifCheck.size === -1) {
                            prepareAndUploadPost(post); // Size unknown; it's an unknown hoster anyways since others send a content-length
                        } else {
                            if (!PROD) console.log(`Gif too small (and not deferred), skipping (size: ${gifCheck.size})`);
                        }
                    } else {
                        if (!PROD) console.log(`Not a working link, got status code ${gifCheck.statusCode}: ${post.url}`);
                    }
                    return;
                }
            }

            link = await createMp4Link(post, gif, domain);
            if (!link) {
                if (domain.includes('i.redd.it')) {
                    // defer loading posts from i.redd.it to avoid an issue where the 'preview' item isn't
                    // yet loaded in the post (probably takes time to process)
                    if (!defer(post, gif)) {
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
            if (!PROD) console.log(`No link gotten for ${gif}`);
            return;
        }

        const gfycatLink = /^https?:\/\/gfycat.com/.test(link);
        post.result.gfycatLink = gfycatLink;
        if (gfycatLink) {
            await gfycat.authenticate();
            const res = await gfycat.getGifDetails({
                gfyId: link.substring(link.lastIndexOf('/') + 1)
            });
            post.result.mp4Size = res.gfyItem.mp4Size;
            post.result.webmSize = res.gfyItem.webmSize;
            if (post.result.gifSize) {
                post.result.gifSize = res.gfyItem.gifSize;
            }
        } else {
            const mp4Check = await checkUrl(link, 'video/mp4', false);
            if (!mp4Check.success) {
                // defer loading to give giphy/tumblr a bit of time to create an mp4
                if (!defer(post, gif, 10) && mp4Check.size < 1000) { // only upload if bigger than a KB
                    prepareAndUploadPost(post);
                }
                return;
            }
            post.result.mp4Size = mp4Check.size;
        }
        post.result.mp4Save = Math.round((post.result.gifSize / post.result.mp4Size) * 100) / 100;
        post.result.webmSave = Math.round((post.result.gifSize / post.result.webmSave) * 100) / 100;
        if (!PROD) console.log(`Link stats: mp4 size: ${post.result.mp4Size} (webm: ${post.result.webmSize});
         that is ${post.result.mp4Save} times smaller (webm: ${post.result.webmSave})`);

        post.mp4link = link;
        cache.setCacheItem(gif, link, post.uploaded);

    } catch (e) {
        stats.onLoopError(e);
    }

}

function defer(post, gif, count = 3) { // TODO extract counts to config
    if (post.deferCount < count) {
        post.deferCount++;
        post.deferred = true;
        stats.onDefer(gif);
        return true;
    }
    post.deferred = false;
    stats.onDeferFail(gif);
    return false;
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
            post = await post.refresh(); // Refresh since post object is the same as before deferral
            link = post.preview.images[0].variants.mp4.source.url; // JSON hell
        } catch (e) {
        }

    }
    return link;
}

function prepareAndUploadPost(post) {
    if (!post.uploading && !post.uploaded) {
        post.deferred = true;
        post.uploading = true;
        uploadPost(post);
    }
}

async function uploadPost(post) {
    if (!PROD) {
        const time = 5000 + Math.random() * 40000;
        console.log(`waiting with fake upload for ${time}`);
        await delay(time);
        console.log(`Not uploading ${post.url}`);
        post.mp4link = 'https://gfycat.com/UncomfortablePleasedAnemoneshrimp';
        post.uploading = false;
        post.uploaded = true;
        return;
    }
    try {
        const gif = post.url.endsWith('/') ? post.url.substring(0, post.url.length - 1) : post.url;
        let link = null;
        const postShortLink = `https://redd.it/${post.id}`;

        await gfycat.authenticate();
        const uploadResult = await gfycat.upload({
            'fetchUrl': gif,
            'title': `Automatically uploaded gif from ${postShortLink}`,
            'nsfw': post.over_18 ? '1' : '0'
        });
        await delay(2000);
        while (link === null) {
            const result = await gfycat.checkUploadStatus(uploadResult.gfyname);
            if (result.task === 'encoding') {
                deasync.sleep(2000); // loop again after a delay
            } else if (result.task === 'complete') {
                link = `https://gfycat.com/${result.gfyname}`;
            } else {
                throw new Error(`Gfycat error: ${result.task}`);
            }
        }
        stats.onUpload(gif, link);
        post.mp4link = link;
        if (link)
            cache.setCacheItem(gif, link, true);
        post.uploading = false;
        post.uploaded = true;
    } catch (e) {
        stats.onLoopError(e);
        post.uploading = false;
        post.uploaded = true;
        post.deferred = false;
    }
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
        result.aboveSizeThreshold = checksize ? result.size > vars.gifSizeThreshold : true;
        if (!result.statusCodeOk) {
            result.success = false;
        } else if (filetype) {
            result.success = result.rightType && result.aboveSizeThreshold;
        }
        if (!PROD) {
            console.log(`Checked ${url}`);
            console.log(JSON.stringify(result));
        }
    } catch (e) {
        stats.onLoopError(e);
    }
    return result;
}

function replaceGifWithMp4(url) {
    if (!url.endsWith('.gif'))
        throw new Error('URL does not end with .gif');
    return url.substring(0, url.length - 4) + '.mp4';
}

function includesPartial(array, term) {
    for (let i = 0; i < array.length; i++) {
        const item = array[i];
        if (item.includes(term) || term.includes(item))
            return true;
    }
    return false;
}

function delay(delay) {
    return new Promise(r => setTimeout(r, delay));
}