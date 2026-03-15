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
      required: true
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


const TRAINER_COMMAND = {
  name: 'trainer',
  description: 'Look up a trainer in the club',
  options: [
    {
      type: 3,
      name: 'name',
      description: 'Name of the trainer in the club',
      required: false
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};


const PARSE_COMMAND = {
  name: 'parse',
  description: 'Scan an uma image and extract the values into a usable format for Umalator',
  options: [
    {
      type: 11,
      name: 'image',
      description: 'Upload a screenshot of your uma',
      required: true
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
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
        { "name": "club finder", "value": "club_finder" },
        { "name": "friend finder", "value": "friend_finder" },
        { "name": "guides", "value": "guides" },
        { "name": "rating optimizer", "value": "rating_optimizer" },
        { "name": "screenshot combiner", "value": "screenshot_combiner" },
        { "name": "skill sheet", "value": "skill_sheet" },
        { "name": "stamina calculator", "value": "stamina_calculator" },
        { "name": "technical document", "value": "technical_document" },
        { "name": "timeline", "value": "timeline" },
        { "name": "umalator", "value": "umalator" }
      ]
    }
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [SUPPORTER_COMMAND, SKILL_COMMAND, UMA_COMMAND, RACE_COMMAND, CM_COMMAND, PARSE_COMMAND, SCHEDULE_COMMAND, RESOURCE_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
