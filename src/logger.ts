enum LogLevels {
    VERBOSE,
    DEBUG,
    INFO,
    WARN,
    ERROR,
    WTF,
}

const LevelNames = ["verbose", "debug", "info", "warn", "error", "assert"];
const LevelColors = [
    ["\u001b[97m", "\u001b[39m"],
    ["\u001b[94m", "\u001b[39m"],
    ["\u001b[92m", "\u001b[39m"],
    ["\u001b[93m", "\u001b[39m"],
    ["\u001b[91m", "\u001b[39m"],
    ["\u001b[95m", "\u001b[39m"],
];

const idRegex = /^\[.{4,8}\]/;
const colorMap = new Map<string, number>();
const availableColors = [
    ["\u001b[91m", "\u001b[39m"], // Bright Red
    ["\u001b[92m", "\u001b[39m"], // Bright Green
    ["\u001b[93m", "\u001b[39m"], // Bright Yellow
    ["\u001b[94m", "\u001b[39m"], // Bright Blue
    ["\u001b[95m", "\u001b[39m"], // Bright Magenta
    ["\u001b[96m", "\u001b[39m"], // Bright Cyan
];
let nextColor = 0;
const availableColorsCount = Object.keys(availableColors).length;

// TODO Give every post ID an individual semi-random color for easy identification? And color log levels.
export default class Logger {

    public static verbose(tag: string, message: string, error?: Error): void {
        return Logger.log(LogLevels.VERBOSE, tag, message, error);
    }

    public static debug(tag: string, message: string, error?: Error): void {
        return Logger.log(LogLevels.DEBUG, tag, message, error);
    }

    public static info(tag: string, message: string, error?: Error): void {
        return Logger.log(LogLevels.INFO, tag, message, error);
    }

    public static warn(tag: string, message: string, error?: Error): void {
        return Logger.log(LogLevels.WARN, tag, message, error);
    }

    public static error(tag: string, message: string, error?: Error): void {
        return Logger.log(LogLevels.ERROR, tag, message, error);
    }

    public static wtf(tag: string, message: string, error?: Error): void {
        Logger.log(LogLevels.WTF, tag, message, error);
        return process.exit(1);
    }

    private static log(level: LogLevels, tag: string, message: string, error?: Error): void {
        const l = Logger.getColoredLevelName(level);
        let m = message;
        if (idRegex.test(message)) {
            const bracketIndex = message.indexOf("]");
            const id = message.substring(1, bracketIndex);
            let col = colorMap.get(id);
            if (col === undefined) {
                col = nextColor;
                colorMap.set(id, nextColor);
                setTimeout(() => { colorMap.delete(id); }, 1000 * 60 * 30).unref();
                nextColor++;
                if (nextColor === availableColorsCount) {
                    nextColor = 0;
                }
            }
            const color = availableColors[col];
            m = `${color[0]}[${id}]${color[1]}${message.substring(bracketIndex + 1)}`;
        }
        console.log(`[${new Date().toISOString()}] ${l}/${tag}: ${m}`, error || ""); // tslint:disable-line no-console
    }

    private static getColoredLevelName(level: LogLevels): string {
        const c = LevelColors[level];
        return `${c[0]}${LevelNames[level]}${c[1]}`;
    }

}
