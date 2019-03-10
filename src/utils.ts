import * as pkg from "../package.json";
import URL2 from "./bot/url2.js";

const byteSizeUnits = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB (Exabyte)", "ZB (Zettayte)", "YB (Yottabyte)", "XB (Xenottabyte)"];

export const version = (pkg as any).version;

export const delay = (ms: number): Promise<void> => {
    return new Promise(r => setTimeout(r, ms));
};

export const getReadableFileSize = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined) {
        return "0 bytes";
    }
    let i = 0;
    while (bytes >= 1000 && i < byteSizeUnits.length - 1) {
        i++;
        bytes /= 1024;
    }
    return `${toFixedFixed(bytes)} ${byteSizeUnits[i]}`;
};

// Because Number#toFixed() doesn't always do what you expect
export const toFixedFixed = (num: number, decimals = 2): string => {
    const multiplier = Math.pow(10, decimals);
    const rounded = `${Math.round(num * multiplier) / multiplier}`;
    const [integer, fraction] = rounded.split(".");
    if (!fraction) {
        return rounded;
    }
    return `${integer}.${fraction.padEnd(decimals, "0")}`;
};

export const removeURLParams = (url: URL2): URL2 => {
    const copy = new URL2(url.href);
    copy.search = "";
    copy.hash = "";
    return copy;
};
