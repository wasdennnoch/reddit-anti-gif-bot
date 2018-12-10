require("dotenv").config(); // tslint:disable-line no-var-requires

import { PrivateMessage } from "snoowrap";
import Ingest from "./ingest";

async function test() {

    console.log("Setting up..."); // tslint:disable-line no-console

    const i = new Ingest({
        sourceOptions: {
            snoowrap: {
                fetchIntervals: {
                    comments: 1337,
                },
            },
        },
    });
    await i.init();

    i.setInboxCallback((message: PrivateMessage) => {
        // In ban messages the author is null. Also they have the subreddit in the subject, easy to parse.
        // So, ban message if was_comment == false, author == null, subject start with "You've been( temporarily)? banned from participating in r/"
        console.log(`[${message.created_utc}] [${message.name}] was_comment: ${message.was_comment}, subject: "${message.subject}" | ${message.author ? message.author.name : message.author}${message.subreddit ? ` in ${message.subreddit.display_name}` : ""}: ${message.body}`); // tslint:disable-line no-console max-line-length
    });

    console.log("Starting ingest..."); // tslint:disable-line no-console
    await i.startIngest();

}

test().catch(console.error); // tslint:disable-line no-console
