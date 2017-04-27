'use strict';

const fs = require('fs');
const path = require('path');
const snoowrap = require('snoowrap');
const Gfycat = require('gfycat-sdk');
const request = require('request-promise-native');
const deasync = require('deasync');
const vars = require('./utils/vars');

const prod = vars.prod;

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
    retryErrorCodes: [], // Disable automatic retry to not spam reddit and we loop anyways
    warnings: !prod
});
const gfycat = new Gfycat({
    clientId: vars.gfycat.clientId,
    clientSecret: vars.gfycat.clientSecret
});

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

        await Promise.all(await createParsePromises(posts));

        deferredPosts = [];
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const link = post.mp4link;
            if (!link && post.deferred) {

                deferredPosts.push(post);

            } else if (link) {
                try {
                    if (prod) {
                        const reply = vars.replyTemplate.replace('%%MP4LINK%%', link).replace('%%TYPE%%', post.uploaded ? 'mirror' : 'link');
                        await post.reply(reply);
                    } else {
                        console.log(`Finished link: ${link} --- uploaded: ${post.uploaded}`);
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

    if (!prod || loops % vars.saveInterval === 0) {
        stats.save();
        cache.save();
    }

}


async function createParsePromises(posts) {
    const promises = [];
    for (let i = 0; i < posts.length; i++) {
        promises.push(Promise.resolve(posts[i]).then(await parsePost));
    }
    return promises;
}

async function parsePost(post) {

    try {

        const gif = post.url.endsWith('/') ? post.url.substring(0, post.url.length - 1) : post.url;
        const domain = post.domain;
        if (post.deferCount === undefined) { // only set the values if they've never been set (deferring)
            post.deferCount = 0;
            post.uploaded = false;
        }
        let link = post.mp4link;

        if (post.uploading || link) { // Currently uploading or already uploaded and passed to this loop
            return;
        }
        if (!link) {
            link = cache.getLink(gif);
        }
        if (link && link !== 'https://i.giphy.com.mp4') { // Already cached (additional check because of previous parsing bug)
            post.mp4link = link;
            stats.onCachedGif(gif, link);
            return;
        }
        if (!await shouldCreateLink(gif)) {
            return;
        }

        if (domain.includes('i.gyazo.com') || domain.includes('media.tumblr.com') || domain.includes('i.makeagif.com') ||
            domain.includes('j.gifs.com') || domain.includes('gifgif.io')) {

            link = replaceGifWithMp4(gif);

        } else if (domain.includes('gfycat.com')) {

            link = gif.replace(/(thumbs\.)|(giant\.)/, '').replace(/(-size_restricted)?(\.gif)$/, '');

        } else if (domain.includes('giphy.com')) {

            if (domain.startsWith('media')) {
                link = gif.substring(0, gif.lastIndexOf('/')).replace(/[a-z0-9]+(\.giphy.com\/media)/, 'i.giphy.com') + '.mp4';
            } else if (domain.startsWith('i.')) {
                link = replaceGifWithMp4(gif);
            } else { // actual website giphy.com
                link = gif.replace('giphy.com/gifs', 'i.giphy.com');
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
                link += '.mp4';
            }

        } else if (domain.includes('i.redd.it')) {

            try {
                link = post.preview.images[0].variants.mp4.source.url; // JSON hell
            } catch (e) {
                if (post.deferCount < 3) {
                    // defer loading posts from i.redd.it to avoid an issue where the 'preview' item isn't yet loaded in the post (probably takes time to process)
                    post.deferCount++;
                    post.deferred = true;
                    stats.onDefer(gif);
                } else {
                    // Image could've been deleted or malformed URL or something else. Just ignore it now.
                    post.deferred = false;
                    stats.onDeferFail(gif);
                }
            }

        } else {

            // upload to gfycat async and defer
            post.deferred = true;
            if (!post.uploading) {
                post.uploading = true;
                uploadPost(post);
            }

        }

        post.mp4link = link;
        if (link) {
            cache.setLink(gif, link, post.uploaded);
        }

    } catch (e) {
        stats.onLoopError(e);
    }

}

async function uploadPost(post) {
    if (!prod) {
        post.mp4link = "fake";
        post.uploading = false;
        post.uploaded = true;
        return;
    }
    try {
        const gif = post.url.endsWith('/') ? post.url.substring(0, post.url.length - 1) : post.url;
        let link = null;
        const postShortLink = `https://reddit.com/${post.id}`;

        await gfycat.authenticate();
        const uploadResult = await gfycat.upload({
            'fetchUrl': gif,
            'title': `Automatically uploaded gif from ${postShortLink}`,
            'nsfw': post.over_18 ? '1' : '0'
        });
        deasync.sleep(2000);
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
            cache.setLink(gif, link, true);
        post.uploading = false;
        post.uploaded = true;
    } catch (e) {
        stats.onLoopError(e);
    }
}

async function shouldCreateLink(url) {
    const res = await request({
        method: 'HEAD',
        uri: url,
        resolveWithFullResponse: true
    });
    if (!prod) {
        console.log(`Type: ${res.headers['content-type']}`);
        console.log(`Length: ${res.headers['content-length']}`);
    }
    return res.headers['content-type'] === 'image/gif' && res.headers['content-length'] > vars.gifSizeThreshold;
}

function replaceGifWithMp4(url) {
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