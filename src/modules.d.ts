declare module "*.json" {
    const value: any;
    export default value;
}

declare module "gfycat-sdk" {

    export = Gfycat;

    class Gfycat {
        apiUrl: string;
        apiVersion: string;
        promiseSupport: boolean;
        token: string;
        retryLimit: number;

        constructor(options: Options);
        authenticate(): Promise<AuthenticationResult>;
        checkUsername(options: { username: string }): Promise<boolean>;
        search(options: SearchOptions): Promise<SearchResult>;
        //getUserDetails(options: { userId: string }): Promise<>;
        getGifDetails(options: { gfyId: string }): Promise<GifDetails>;
        //getRelatedContent(options: { gfyId: string }): Promise<>;
        //getCategories(): Promise<>;
        //getTrendingCategories(): Promise<>;
        //userFeed(options: { userId: string }): Promise<>;
        //trendingGifs(options: { count: number }): Promise<>;
        //trendingTags(): Promise<>;
        upload(options: UploadOptions): Promise<{ gfyname: string }>;
        //stickers(): Promise<>;
        checkUploadStatus(gfyId: string): Promise<UploadStatusResult>;
    }

    interface Options {
        clientId: string;
        clientSecret: string;
    }

    interface SearchOptions {
        search_text: string;
        random?: boolean;
        count?: number;
        cursor?: number;
        first?: number;
    }

    interface UploadOptions {
        fetchUrl: string;
        noMd5?: boolean;
        title?: string;
        description?: string;
        tags?: string[];
        private?: 0 | 1;
        nsfw?: '0' | '1' | '3';
        fetchSeconds?: number;
        fetchMinutes?: number;
        fetchHours?: number;
        captions?: UploadCaptions[];
        cut?: {
            duration: number;
            start: number;
        };
        crop?: UploadCrop[];
    }

    interface UploadCaptions {
        text: string;
        startSeconds?: number;
        duration?: number;
        fontHeight?: number;
        fontHeightRelative?: number;
        x?: number;
        y?: number;
        xRelative?: number;
        yRelative?: number;
    }

    interface UploadCrop {
        x: number;
        y: number;
        w: number;
        h: number;
    }

    interface UploadStatusResult {
        task: 'encoding' | 'complete' | 'NotFoundo' | 'error';
        time?: number;
        gfyname?: string;
        errorMessage?: {
            code: number;
            description: string;
        }
    }

    interface AuthenticationResult {
        token_type: 'bearer';
        scope: string;
        expires_in: number;
        access_token: string;
    }

    interface SearchResult {
        cursor: string;
        gfycats: GfyItem[];
        related: string[];
        found: number;
    }

    interface GifDetails {
        gfyItem: GfyItem;
        errorMessage?: string;
    }

    interface GfyItem {
        gfyId: string;
        gfyName: string;
        gfyNumber: string;
        gifUrl: string;
        mp4Url: string;
        webmUrl: string;
        webpUrl: string;
        mobileUrl: string;
        mobilePosterUrl: string;
        extraLemmas: string;
        thumb100PosterUrl: string;
        miniUrl: string;
        miniPosterUrl: string;
        gif100px: string;
        posterUrl: string;
        max5mbGif: string;
        max2mbGif: string;
        max1mbGif: string;
        width: number;
        height: number;
        avgColor: string;
        frameRate: number;
        numFrames: number;
        gifSize: number;
        mp4Size: number;
        webmSize: number;
        createDate: number;
        md5?: string;
        url?: string;
        source: number;
        nsfw: '0' | '1' | '3';
        gatekeeper: number; // I've seen 0 and 5 so far
        likes: number | string; // ...really gfycat?
        dislikes: number | string;
        published: 0 | 1;
        views: number;
        tags: string[] | null;
        userName: string;
        title: string;
        description: string;
        languageText?: string;
        languageText2: string;
        languageCategories: string[] | null;
        sar?: number;
        subreddit?: string;
        redditId?: string;
        redditIdText?: string;
        domainWhitelist: Array<any>; // ?
        geoWhitelist?: Array<any>; // ??
        hasTransparency: boolean;
        hasAudio: boolean;
        curated: 0 | 1;
        userDisplayName?: string;
        userProfileImageUrl?: string;
        userData?: {
            name: string;
            profileImageUrl: string;
            url: string;
            username: string;
            followers: number;
            following: number;
            profileUrl: string;
            views: number;
            verified: boolean;
        };
        content_urls: {
            max2mbGif: ContentUrlItem;
            max1mbGif: ContentUrlItem;
            webp?: ContentUrlItem;
            "100pxGif": ContentUrlItem;
            mobilePoster?: ContentUrlItem;
            mp4?: ContentUrlItem;
            webm?: ContentUrlItem;
            max5mbGif: ContentUrlItem;
            largeGif: ContentUrlItem;
            mobile?: ContentUrlItem;
        };
    }

    interface ContentUrlItem {
        url: string;
        size: number;
        height: number;
        width: number;
    }

}
