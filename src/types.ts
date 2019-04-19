import Snoowrap = require("snoowrap");
import { ReplyableContent } from "snoowrap";

export enum LocationTypes {
    SUBREDDIT = "subreddit",
    USER = "user",
    DOMAIN = "domain",
}

export enum ItemTypes {
    SUBMISSION = "submission",
    COMMENT = "comment",
    INBOX = "inbox",
}

// ReplyableContent doesn't have an author object; ReplyableContent does but PrivateMessage
// doesn't extend ReplyableContent and instead has its own author object.
// This interface ensures that passed ReplyableContent objects have an author as well.
export interface ReplyableContentWithAuthor<T> extends ReplyableContent<T> {
    author: Snoowrap.RedditUser;
}
