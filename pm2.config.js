module.exports = {
    apps: [{
        name: "antigifbot",
        script: "./src/index.js",
        watch: false,
        cron_restart: "0 18 * * *", // TODO Really shouldn't be needed after the rewrite anymore
        env: {
            "NODE_ENV": "development",
            "PROD": "false"
        },
        env_production : {
            "NODE_ENV": "production",
            "PROD": "true"
        }
    }]
}