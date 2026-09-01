require('dotenv/config');
const {REST, Routes} = require("discord.js")
// Your bot's Application ID and your server's (guild's) ID, both from the
// Discord Developer Portal / Developer Mode - see .env.example.
const botID = process.env.BOT_ID
const serverID = process.env.GUILD_ID
const botToken = process.env.TOKEN

if (!botID || !serverID || !botToken) {
    console.error('Missing BOT_ID / GUILD_ID / TOKEN in .env - see .env.example and instructions.txt.');
    process.exit(1);
}

const rest = new REST().setToken(botToken)
const slashRegister = async () => {
    try {
await rest.put(Routes.applicationGuildCommands(botID, serverID), {
    body: [
        {
            name: 'skibidi',
            description: 'Skibidi toilet!'
        },
        {
            name: 'link',
            description: 'Link your Discord account to your Genshin Impact UID',
            options: [
                {
                    name: 'uid',
                    description: 'Your 9-10 digit Genshin UID',
                    type: 3, // STRING
                    required: true
                }
            ]
        },
        {
            name: 'analyze',
            description: 'Analyze a Genshin Impact build using your Character Showcase',
            options: [
                {
                    name: 'uid',
                    description: 'A Genshin UID to analyze (defaults to your linked UID)',
                    type: 3, // STRING
                    required: false
                },
                {
                    name: 'user',
                    description: 'Analyze a linked Discord user instead',
                    type: 6, // USER
                    required: false
                }
            ]
        },
        {
            name: 'search',
            description: 'Directly ask Gumy to search the web for something',
            options: [
                {
                    name: 'query',
                    description: 'What do you want Gumy to look up?',
                    type: 3, // STRING
                    required: true
                }
            ]
        },
        {
            name: 'quota',
            description: 'Check your remaining daily usage for /analyze, /search, and chat messages'
        }
    ]
})
    } catch (error) {
        console.error(error)
    }
}
slashRegister();