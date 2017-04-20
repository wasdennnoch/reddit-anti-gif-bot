'use strict';

const fs = require('fs');
const path = require('path');
const pkgReader = require('./utils/package-reader');
const snoowrap = require('snoowrap');
const Gfycat = require('gfycat-sdk');
const deasync = require('deasync');
const Stats = require('./utils/stats');
const LinkCache = require('./utils/link-cache');

const cachePath = path.join(__dirname, 'json', 'linkCache.json');
const statsPath = path.join(__dirname, 'json', 'stats.json');
const configPath = path.join(__dirname, 'json', 'config.json');
const secretPath = path.join(__dirname, '..', '.secret');
const keys = JSON.parse(fs.readFileSync(path.join(secretPath, 'keys.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const updateInterval = config.updateInterval;
const saveInterval = config.saveInterval;
const knownDomains = config.knownDomains;
const nonDotGifDomains = config.nonDotGifDomains;
const ignoreDomains = config.ignoreDomains;
const ignoreSubreddits = config.ignoreSubreddits;
const ignoreSubredditsPartial = config.ignoreSubredditsPartial;
const replyTemplate = config.replyTemplate;
const prod = process.env.PROD || false;
const log = !prod;

const stats = new Stats(statsPath, log);
const cache = new LinkCache(cachePath, stats, config.cacheSize, config.cachePurgeSize);
const userAgent = `bot:anti-gif-bot:${pkgReader.getVersion()}`;
const reddit = new snoowrap({
    userAgent: userAgent,
    clientId: keys.reddit.clientId,
    clientSecret: keys.reddit.clientSecret,
    username: keys.reddit.username,
    password: keys.reddit.password
});
const gfycat = new Gfycat({
    clientId: keys.gfycat.clientId,
    clientSecret: keys.gfycat.clientSecret
});

let lastPost = undefined;
let loops = 0; // keep track of loops here to regulary persist stats/cache
let deferredPosts = [];

console.log('[anti-gif-bot] Ready.');

module.exports.start = () => {
    console.log('[anti-gif-bot] Started');
    setInterval(update, updateInterval);
    update();
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
            if (!post.domain.startsWith('self.') && !post.over_18 && !includesPartial(ignoreDomains, post.domain)
                && !ignoreSubreddits.includes(post.subreddit.display_name) && !includesPartial(ignoreSubredditsPartial, post.subreddit.display_name)) {
                if ((includesPartial(knownDomains, post.domain) && post.url.endsWith('.gif')) || includesPartial(nonDotGifDomains, post.domain) || post.url.endsWith('.gif')) {
                    sorted.push(post);
                    stats.onGif(post.url);
                    if (!includesPartial(knownDomains, post.domain) && post.url.endsWith('.gif')) {
                        stats.onUnknownDomain(post.domain);
                    } else {
                        stats.onDomain(post.domain);
                    }
                }
            }
        });
        let posts = sorted;
        posts = posts.concat(deferredPosts);


        const newDeferredPosts = [];
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const gif = post.url.endsWith('/') ? post.url.substring(0, post.url.length - 1) : post.url;
            const domain = post.domain;
            if (post.deferCount === undefined) { // only set the values if they've never been set (deferring)
                post.deferCount = 0;
                post.uploaded = false;
            }
            let link = post.mp4link;

            if (link) { // Uploaded and passed to this loop
                continue;
            }
            if (!link) {
                link = cache.getLink(gif);
            }
            if (link) { // Already cached
                post.mp4link = link;
                stats.onCachedGif(gif, link);
                continue;
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
                    if (link.lastIndexOf('/') < link.length - 12) {
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
                    link = await post.refresh().preview.images[0].variants.mp4.source.url; // JSON hell
                } catch (e) {
                    if (post.deferCount < 3) {
                        // defer loading posts from i.redd.it to avoid an issue where the 'preview' item isn't yet loaded in the post (probably takes time to process)
                        post.deferCount++;
                        newDeferredPosts.push(post);
                        stats.onDefer(gif);
                    } else {
                        // Image could've been deleted or malformed URL or something else. Just ignore it now.
                        stats.onDeferFail(gif);
                    }
                }

            } else {

                // upload to gfycat async to not interfere with the next interval (deferring gets screded up)
                if (!post.uploaded) {
                    uploadPost(post);
                }

            }

            post.mp4link = link;
            if (link)
                cache.setLink(gif, link, post.uploaded);
        }
        deferredPosts = newDeferredPosts;


        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const link = post.mp4link;
            if (!link)
                continue;

            //noinspection JSUnusedLocalSymbols
            const reply = replyTemplate.replace('%%MP4LINK%%', link).replace('%%TYPE%%', post.uploaded ? 'mirror' : 'link');

            try {
                if (prod) {
                    await post.reply(reply);
                } else {
                    console.log(`Finished link: ${link}`);
                }
            } catch (e) {
                if (e.toString().includes('403') || e.toString().includes('Forbidden'))
                    stats.onPossibleBanError(e, post.subreddit.display_name);
                else
                    throw e;
            }
        }


    } catch (e) {
        stats.onLoopError(e);
    }

    if (!prod || loops % saveInterval === 0) {
        stats.save();
        cache.save();
    }

}

async function uploadPost(post) {
    try {
        post.uploaded = true;
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
            cache.setLink(gif, link, post.uploaded);
        deferredPosts.push(post); // let it being processed by the next loop
    } catch (e) {
        stats.onLoopError(e);
    }
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