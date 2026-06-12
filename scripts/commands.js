import 'dotenv/config';
import { capitalize, InstallGlobalCommands } from './utils.js';

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const SUPPORTER_COMMAND = {
  name: 'supporter',
  description: 'Lookup a supporter card',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the card or character',
      required: true
    },
    {
      type: 4, // INTEGER
      name: "limitbreak",
      description: "Limit Break Level (0–4)",
      required: false,
      min_value: 0,
      max_value: 4,
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const SKILL_COMMAND = {
  name: 'skill',
  description: 'Lookup a skill',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the skill',
      required: true,
      autocomplete: true
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const UMA_COMMAND = {
  name: 'uma',
  description: 'Lookup a horse',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the horse',
      required: true
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const EVENT_COMMAND = {
  name: 'event',
  description: 'Lookup an event',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the event',
      required: true
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const RACE_COMMAND = {
  name: 'race',
  description: 'Lookup a race',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the race',
      required: false
    },
    {
      type: 3, // STRING
      name: 'grade',
      description: 'Filter by race grade (G1, G2, G3, EX)',
      required: false,
      choices: [
        { name: 'G1', value: 'G1' },
        { name: 'G2', value: 'G2' },
        { name: 'G3', value: 'G3' },
        { name: 'EX', value: 'EX' }
      ]
    },
    {
      type: 3, // STRING
      name: 'year',
      description: 'Filter by training year (Junior, Classic, Senior)',
      required: false,
      choices: [
        { name: 'Junior Year', value: 'Junior Year' },
        { name: 'Classic Year', value: 'Classic Year' },
        { name: 'Senior Year', value: 'Senior Year' }
      ]
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const CM_COMMAND = {
  name: 'cm',
  description: 'Lookup a champion\'s meet',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the champion\'s meet',
      required: true
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
}; 

const GUILD_ADMIN_PERMISSIONS = '8';

const REGISTER_COMMAND = {
  name: 'register',
  description: 'Link your Discord account to your Umamusume trainer ID',
  options: [
    {
      type: 3,
      name: 'id',
      description: 'Your Umamusume Global ID',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const PROFILE_COMMAND = {
  name: 'profile',
  description: 'Show your linked trainer profile, or look up a trainer on this server',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Trainer name to look up (server clubs only)',
      required: false,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const CLUB_COMMAND = {
  name: 'club',
  description: 'Club leaderboards and server configuration',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 1,
      name: 'registerclub',
      description: 'Link this server to an Umamusume club (admin only)',
      options: [
        {
          type: 4,
          name: 'id',
          description: 'Club ID from Umamusume / uma.moe (e.g. 883948934)',
          required: true,
          min_value: 1,
        },
      ],
    },
    {
      type: 1,
      name: 'unregisterclub',
      description: 'Remove a club link from this server (admin only)',
      options: [
        {
          type: 4,
          name: 'id',
          description: 'Club ID to unregister',
          required: true,
          min_value: 1,
        },
      ],
    },
    {
      type: 1,
      name: 'registerforced',
      description: 'Force-link a user to a trainer ID (admin only)',
      options: [
        {
          type: 6,
          name: 'user',
          description: 'Discord user to link',
          required: true,
        },
        {
          type: 3,
          name: 'id',
          description: 'Umamusume Global ID',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: 'leaderboard',
      description: 'Show a club monthly fans leaderboard',
      options: [
        {
          type: 3,
          name: 'clubname',
          description: 'Club name to show (defaults to your linked club)',
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      type: 1,
      name: 'setleaderboardchannel',
      description: 'Post an auto-updating club leaderboard in this channel (admin only)',
      options: [
        {
          type: 3,
          name: 'clubname',
          description: 'Registered club name for this server',
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      type: 1,
      name: 'setpremium',
      description: 'Enable or disable premium leaderboard refresh (owner only)',
      options: [
        {
          type: 5,
          name: 'enabled',
          description: 'Grant premium (5-minute top-100 refresh)?',
          required: true,
        },
      ],
    },
  ],
};

const QUIZ_COMMAND = {
  name: 'quiz',
  description: 'Umamusume quiz games',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 1,
      name: 'start',
      description: 'Start a quiz in this channel',
      options: [
        {
          type: 3,
          name: 'mode',
          description: 'Quiz mode',
          required: false,
          choices: [
            { name: 'Umastan', value: 'umastan' },
            { name: 'Gamer', value: 'gamer' },
            { name: 'Larper', value: 'larper' },
            { name: 'Umadol', value: 'umadol' },
            { name: 'Umaguesser', value: 'umaguesser' },
          ],
        },
        {
          type: 4,
          name: 'timer',
          description: 'Seconds per round (10–30)',
          required: false,
          min_value: 10,
          max_value: 30,
        },
        {
          type: 3,
          name: 'difficulty',
          description: 'Question difficulty',
          required: false,
          choices: [
            { name: 'Easy', value: 'easy' },
            { name: 'Medium', value: 'medium' },
            { name: 'Hard', value: 'hard' },
            { name: 'Expert', value: 'expert' },
          ],
        },
        {
          type: 4,
          name: 'scoregoal',
          description: 'Points needed to win (10–50)',
          required: false,
          min_value: 10,
          max_value: 50,
        },
        {
          type: 3,
          name: 'audio',
          description: 'Include audio questions?',
          required: false,
          choices: [
            { name: 'Yes', value: 'yes' },
            { name: 'No', value: 'no' },
          ],
        },
        {
          type: 3,
          name: 'picture',
          description: 'Include picture questions?',
          required: false,
          choices: [
            { name: 'Yes', value: 'yes' },
            { name: 'No', value: 'no' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'stop',
      description: 'Stop the active quiz (admin only)',
    },
    {
      type: 1,
      name: 'notify',
      description: 'Toggle quiz ping role (tazuna-quiz-role)',
    },
  ],
};

const SCHEDULE_COMMAND = {
  name: "schedule",
  description: "See the current month's schedule",
  type: 1,
  integration_types: [0, 1], 
  contexts: [0, 1, 2],
};

const RESOURCE_COMMAND = {
  name: 'resource',
  description: 'Get the link to a specific resource',
  options: [
    {
      type: 3,
      name: 'mode',
      description: 'Resource options',
      required: true,
      choices: [
        { "name": "bible", "value": "bible" },
        { "name": "friend finder", "value": "friend_finder" },
        { "name": "pull planner", "value": "pull_planner" },
        { "name": "rating optimizer", "value": "rating_optimizer" },
        { "name": "screenshot combiner", "value": "screenshot_combiner" },
        { "name": "skill sheet", "value": "skill_sheet" },
        { "name": "stamina calculator", "value": "stamina_calculator" },
        { "name": "technical document", "value": "technical_document" },
        { "name": "timeline", "value": "timeline" },
        { "name": "trophy hunter", "value": "trophy_hunter" },
        { "name": "umalator", "value": "umalator" }
      ]
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const EPITHET_COMMAND = {
  name: 'epithet',
  description: 'Look up epithets: list all, filter by keyword, or view one.',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Filter by epithet name/alias (e.g. "dirt"). Leave empty to list all.',
      required: false
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const QP_COMMAND = {
  name: 'qp',
  description: 'Show a quick picture guide',
  options: [
    {
      type: 3,
      name: 'guide',
      description: 'Which guide image to show',
      required: true,
      choices: [
        { name: 'Sample Race Schedule', value: 'sample_schedule' },
        { name: 'Race Bonus and Hammers', value: 'race_bonus_and_hammers' },
        { name: 'Consecutive Race Penalty', value: 'consecutive_race_penalty' },
        { name: 'Trackblazer Mood & Energy Events', value: 'mood_energy_mant' },
        { name: 'Unique Levels', value: 'unique_levels' }
      ]
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const DONATE_COMMAND = {
  name: 'donate',
  description: 'Support the bot — hosting isn\'t free!',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const BUGREPORT_COMMAND = {
  name: 'bugreport',
  description: 'Report a bug or issue to the developer',
  options: [
    {
      type: 3, // STRING
      name: 'description',
      description: 'Describe the bug or issue you encountered',
      required: true,
    },
    {
      type: 11, // ATTACHMENT
      name: 'image',
      description: 'Optional screenshot illustrating the issue',
      required: false,
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const REFRESHCACHE_COMMAND = {
  name: 'refreshcache',
  description: 'Refresh bot cache from GitHub (owner only)',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [
  SUPPORTER_COMMAND,
  SKILL_COMMAND,
  UMA_COMMAND,
  RACE_COMMAND,
  CM_COMMAND,
  REGISTER_COMMAND,
  PROFILE_COMMAND,
  CLUB_COMMAND,
  QUIZ_COMMAND,
  SCHEDULE_COMMAND,
  RESOURCE_COMMAND,
  EPITHET_COMMAND,
  QP_COMMAND,
  DONATE_COMMAND,
  BUGREPORT_COMMAND,
  REFRESHCACHE_COMMAND,
];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
