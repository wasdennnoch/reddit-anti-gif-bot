# reddit-anti-gif-bot

The source of [u/anti-gif-bot](https://reddit.com/u/anti-gif-bot), a bot which provides an mp4
link/mirror for gif submissions.

You can find an FAQ here: https://reddit.com/r/anti_gif_bot/wiki/index
&nbsp;

## How it works

Some technical stuff; this bot is written in JavaScript and runs on Node.js. It uses the
library [snoowrap](https://github.com/not-an-aardvark/snoowrap) for every interaction with
Reddit and the official [gfycat-sdk](https://github.com/gfycat/gfycat-sdk) to upload to gfycat.
Every 15 seconds the bot fetches /r/all/new to get the newest submissions and filters all
gif submissions. If the gif domain is known for providing an mp4 version the gif url gets
converted to an mp4 link, otherwise a request to gfycat is made containing the gif url.
After an mp4 link is generated (or gfycat is done converting the gif) a reply containing that
link gets posted. That's it basically. There are a few more things such as a domain blacklist
(the gifv-bot already covers gifs from imgur) and an internal stats counter that keeps track
of the amount of submissions the bot scraped, the amount of gifs, domains that host gifs etc.
Maybe I'll eventually create a website where I make these stats available. Until then I'll
keep them private (well, I accidentally committed a dev version once but whatever, it's no secret)
to enhance the bot and for my own curiosity.

## Contribution

If you find any bugs or want to submit an enhancement feel free to open an issue or
submit a pull request and I'll look into it!
