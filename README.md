# TazunaBot

A Discord bot for looking up uma information such as skills, races and support cards.
Any questions? Join the discord [https://discord.gg/5BW4gSUVSz](https://discord.gg/5BW4gSUVSz)

The bot is currently hosted on a $15 per month server. Please consider donating to help keep it online.

[ko-fi](https://ko-fi.com/K3K5C7U3C)

## ⭐ Commands

Here are the features of the bot. Some of them are still a Work in Progress.  

`/uma` - Looks up information on a specific uma. Shows their unique skill, aptitudes and skills. Able to accept some common aliases as input. Also able to lookup variants such as McQueen Anime.  
Accepts name as a parameter. Can also accept nickname + type

`/skill` - Looks up information on a specific skill and explained in a more detailed explanation than the vague descriptions in game.  
Accepts name as a parameter

`/supporter` - Looks up information on a specific Supporter Card. Able to accept rarity as input; if you're looking for Kitasan Black SSR, you can type /supporter Kitasan SSR and it will work. Also able to limit the result to a specific Limit Break.  
Accepts name and limit break as a parameter

`/race` - Looks up information on a specific race. Can filter by year and grade  
Accepts name, year and grade as a parameter

`/cm` - Looks up information on a specific Champion's Meeting  
Accepts name as a parameter

`/parse` - Parses an image of your uma's final result page and tries to generate an umalator link (This will be deprecated soon for Moomoolator's OCR)  
Accepts am image as a parameter

`/resource` - Shows the links to nifty uma tools such as stamina calculator, banner timeline, etc.

`/epithet` - Lists specific epithets and their conditions. For example, use `/epithet mile` to see only mile related epithets. Can also do `/epithet mant mile` to filter the epithet list to Trackblazer scenario only.

`/qp` - Shows a quick picture guide on a specific topic such as race bonus and hammers value or racing penalty in trackblazer.


## 🧪 Tests

Needs Node 22 or newer.

```sh
npm ci
npm test        # slash command handlers + the /api endpoints the dashboard uses
npm run check   # syntax-check every file in scripts/
```

The tests start the bot in-process on a random port with a throwaway data folder
(`TAZUNA_DATA_DIR`), local assets, a generated Discord signing key, and all outbound
network calls blocked, so they never touch your `.env`, `data/`, or real services.
GitHub Actions runs both on every push to `main` and on pull requests.
