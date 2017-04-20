# reddit-anti-gif-bot

The source of [u/anti-gif-bot](https://reddit.com/u/anti-gif-bot), a bot which provides an mp4
link/mirror for gif submissions.

*Since the bot is very new it may be ratelimited by Reddit in the first few days. Just upvote
it so it gets enough karma to lift the limit. This is a spam prevention method from Reddit,
I'm not begging for fake internet points.*

## Why?

As we all know gifs are a very old technique to save animated images of cute cats and
share them with the world. These images have been bringing joy to -
ah whatever, you all know what gifs are.

And as you might (should) also know gifs are HUGE. A 15 seconds long 720p video with 25fps for
example takes up 160MB as a gif! For comparison, an mp4 version of the same video only takes
up 12.5MB. A webm even only 1.8MB. As you see there is a HUGE difference in file size. For
the sake of us all and our data caps (and mobile users) please always submit links to mp4
versions whenever possible.

Unfortunately not all gif hosters make it as easy to simply copy a link to an mp4 version.
This is where this bot comes into play; it regulary looks through all new submissions and
if the submission directly links a gif the bot comments with a link to an mp4 version. Many
popular hosters already host mp4s themselves but if they don't provide alternative versions
this bot uploads the gif to gfycat which then converts it to an mp4.


## How?

Now some technical stuff. This bot is written in JavaScript and runs on Node.js. It uses the
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
keep them private (well, I accidentally commited a dev version but whatever, it's no secret)
to enhance the bot and for my own curiosity.

## And I?

If you find any bugs or want to submit an enhancement feel free to submit a pull request and
I'll update the bot quickly!
