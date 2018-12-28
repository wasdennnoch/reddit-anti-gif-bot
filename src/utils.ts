import * as pkg from "../package.json";

const byteSizeUnits = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB (Exabyte)", "ZB (Zettayte)", "YB (Yottabyte)", "XB (Xenottabyte)"];

export const version = (pkg as any).version;

export const delay = (ms: number): Promise<void> => {
    return new Promise(r => setTimeout(r, ms));
};

export const getReadableFileSize = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined) {
        return "";
    }
    let i = 0;
    while (bytes >= 1000 && i < byteSizeUnits.length - 1) {
        i++;
        bytes /= 1024;
    }
    return `${toFixedFixed(bytes)} ${byteSizeUnits[i]}`;
};

// Because Number#toFixed() doesn't always do what you expect
export const toFixedFixed = (num: number, decimals = 2): number => {
    decimals = Math.pow(10, decimals);
    return Math.round(num * decimals) / decimals;
};
