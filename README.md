# TazunaBot

A Discord bot for managing your umamusume club and other nifty uma commands. 
Any questions? Join the discord https://discord.gg/5BW4gSUVSz
---

## 🚀 Getting Started
Follow these steps to run the bot locally. You can also host this bot on a free server like pella.



### 1. Install dependencies
Before you start, you'll need to install [NodeJS](https://nodejs.org/en/download/) and [create a Discord app](https://discord.com/developers/applications). Feel free to name the bot anything you want and upload a nice icon.

### 2a. Clone the repository
```
git clone https://github.com/JustWastingTime/TazunaDiscordBot.git
cd TazunaDiscordBot
npm install
```

### 2b. Fork the repository
If you'd like to still receive updates on the bot (as it is a Work in Progress), you can fork the repo instead of cloning it. I'm not gonna expand much on this as you should have some knowledge on this already if you are picking this option.

### 3. Create your credentials file
Rename .env.sample to just .env.  
Head to the discord app you just created and copy the application id (`APP_ID`) and public key (`PUBLIC_KEY`) into the .env file. Then head into the Bot page and generate a Bot Token and save it as (`DISCORD_TOKEN`) in the .env.
![Finding the secrets](./assets/readmeimg/tutorial01.png)


### 4. Install slash commands

The commands are set up in `commands.js` (more on the commands later). All of the commands in the `ALL_COMMANDS` array at the bottom of `commands.js` will be installed when you run the `register` command configured in `package.json`:

```
npm run register
```

### 5. Run the app

After your credentials are added, go ahead and run the app:

```
npm run start
```

### 6a. Set up interactivity

The project needs a public endpoint where Discord can send requests. To develop and test locally, you can use something like [`ngrok`](https://ngrok.com/) to tunnel HTTP traffic.

Install ngrok if you haven't already, then start listening on port `3000`:

```
ngrok http 3000
```

You should see your connection open:

```
Tunnel Status                 online
Version                       2.0/2.0
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://1234-someurl.ngrok.io -> localhost:3000

Connections                  ttl     opn     rt1     rt5     p50     p90
                              0       0       0.00    0.00    0.00    0.00
```

Copy the forwarding address that starts with `https`, in this case `https://1234-someurl.ngrok.io`, then go to your [app's settings](https://discord.com/developers/applications).

On the **General Information** tab, there will be an **Interactions Endpoint URL**. Paste your ngrok address there, and append `/interactions` to it (`https://1234-someurl.ngrok.io/interactions` in the example).

Click **Save Changes**, and your app should be ready to run 🚀
![Setting up the discord endpoint url with ngrok](./assets/readmeimg/tutorial02.png)

### 6b. Using free hosting
Sign up on a free web app hosting service such as pella.app and select Web App. Select the Express JS type and upload the current folder as a zip. In this case, do not upload the .env file and instead copy down the .env keys into the settings panel of your web app. Save and press start.  
![Setting up the discord endpoint url with a free public hosting like pella](./assets/readmeimg/tutorial03.png)

Go to the Manage tab and copy the domain given here. On the **General Information** tab, there will be an **Interactions Endpoint URL**. Paste your address there, and append `/interactions` to it (`https://someweirdname.onpella.app/interactions`).

Click **Save Changes**, and your app should be ready to run 🚀


## ⭐ Commands
Here are the features of the bot. Some of them are still a Work in Progress.  

`/uma` - Looks up information on a specific uma. Shows their unique skill, aptitudes and skills. Able to accept some common aliases as input. Also able to lookup variants such as McQueen Anime.  
![Accepts name as a parameter. Can also accept nickname + type](./assets/readmeimg/tutorial05.png)

`/skill` - Looks up information on a specific skill and explained in a more detailed explanation than the vague descriptions in game.  
![Accepts name as a parameter](./assets/readmeimg/tutorial06.png)

`/supporter` - Looks up information on a specific Supporter Card. Able to accept rarity as input; if you're looking for Kitasan Black SSR, you can type /supporter Kitasan SSR and it will work. Also able to limit the result to a specific Limit Break.  
![Accepts name and limit break as a parameter](./assets/readmeimg/tutorial07.png)

`/event` - Looks up information on a specific supporter event, uma event or generic event. (This is slowly getting updated, is a WIP)  
![Accepts event name or uma name as a parameter](./assets/readmeimg/tutorial08.png)

`/race` - Looks up information on a specific race. Can filter by year and grade  
![Accepts name, year and grade as a parameter](./assets/readmeimg/tutorial09.png)

`/cm` - Looks up information on a specific Champion's Meeting  
![Accepts name as a parameter](./assets/readmeimg/tutorial04.png)

`/parse` - Parses an image of your uma's final result page and tries to generate an umalator link (This is a WIP and is not functional yet)  
![Accepts am image as a parameter](./assets/readmeimg/tutorial10.png)

`/trainer` - Looks up information on a specific trainer in your club. Leaving it blank shows your profile. [REQUIRES SHEET SETUP]  
![Accepts name as a parameter](./assets/readmeimg/tutorial11.png)

`/leaderboard` - Looks up the current club members' rankings. Can change mode between monthly and total. Default is monthly. [REQUIRES SHEET SETUP]  
![Accepts name as a parameter](./assets/readmeimg/tutorial12.png)

`/log` - Allows users to upload their fancount into the google sheets. [REQUIRES SHEET SETUP]  
![Accepts name as a parameter](./assets/readmeimg/tutorial13.png)

`/register` - Saves an umalator link into your trainer profile for easy access and comparison with club mates. Only 5 save slots. [REQUIRES SHEET SETUP]  
![Accepts label, slot and a url as a parameter](./assets/readmeimg/tutorial14.png)

`/apply` - Allows new users to apply to your guild and setup a profile. Needs their uma name, uma id and total fan count as input. [REQUIRES SHEET SETUP]  
![Accepts name, id and fan count as a parameter](./assets/readmeimg/tutorial15.png)

`/setchannel` - Sets the channel in which new member applicants will appear in. A user (ideally an admin/moderator only channel) will approve this applicant before the trainer profile is added to the sheets and bot. (Work in Progress) [REQUIRES SHEET SETUP]  
![Accepts name as a parameter](./assets/readmeimg/tutorial16.png)

## ⭐ Setting up the sheets
Create a copy of this sheet https://docs.google.com/spreadsheets/d/1xyOJpbC-CdmUV1uSgOyEUT68WnxUGMXiNP5RonUuR4Y/
If your club runs a dynamic quota based on medians, use the first sheet. If your club runs a fixed daily quota, delete the first sheet and rename the "Fixed Quota version" sheet to "Data".

## ⭐ Changing the emojis
Work in Progress.  

## ⭐ Parsing images
`/parse` accepts a screenshot of your uma, parses it into something readable, and generates an umalator link. There are some hiccups like skills not being properly read if there are ○ or ◎, so please double check your final umalator result.  

To get the parser working, generate a free [OCR API key] (https://ocr.space/ocrapi/freekey) and paste it into your .env file. If you're using a host like Pella, add this key into the env tab instead.

Example: ![Sample Uma Picture](./assets/readmeimg/parsesample.png)
This is the result
![Sample Uma Result](./assets/readmeimg/parsesampleresult.png)
And the umalator link generated
https://alpha123.github.io/uma-tools/umalator-global/#H4sIAAAAAAAACu2QvU4DMRCEXwVN7WJ9R%2B6Eu1QI0SCloEAUVrxJLHL2yWsriqK8O1o4gVLS042%2B%2FZudC7a5FeGnAGdpoMEgiZ%2FmIwvcisigCb9keWae4WppbFD8lgPv4C6Ycg5wncG%2B5JYCHB6VGJzY1wMXOGxaSmcYCHvJScFcYtrDoMaJl2EfWO%2FT1aBN3urqNnk1BUvWwiB5bcZj8SJ3rzkFLjDIre5i%2Fekj7ZSZWb%2Bx6l6qn2LycIO1BnM%2BqSfbaWnfqsD13WhwihLyBNcPvYF8xONR4N5giezX8Qciul9EN6roiPq%2BW8S4iIGW0mAXMi7EDiuLd7VTfOX9WWPwcogwCFGqT1tezzXWpjlgrV%2B0svM3dIPf%2BRv8HVr3H9qfQrt%2BAiSBJtf7AgAA