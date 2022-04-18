import * as MRE from '@microsoft/mixed-reality-extension-sdk';
import * as UI from "./ui";
import * as Audio from "./audio";
import * as Utils from "./utils";

const fetch = require('node-fetch');
const MAX_CHOICES = 6;
const MAIN_BUTTON_SPACING = 0.34;
const SEPARATOR = '|';
const EXAMPLE = "man's best friend|dog|cat|other";
const POLL_BUTTON_TEXT = `Enter a question and click "OK" to start a new poll. Add custom answers at the end separated by "|". Leave empty to see an example: \n\n"${EXAMPLE}"\n\nLearn more at github.com/tuesy/jimmypoll`;
const DEBUG = false;

export type PollDescriptor = {
  name: string,
  choices: ChoiceDescriptor[],
  answer?: string,
  difficulty?: string,
  category?: string
};

export type ImportedPollDescriptor = {
  name: string,
  choices: string[],
  answer?: string,
  difficulty?: string,
  category?: string
}

export type ChoiceDescriptor = {
  name: string,
  userIds: Set<MRE.Guid>
}

export default class JimmyPoll {
	public assets: MRE.AssetContainer;

  private screen: MRE.Actor;
  private header: MRE.Actor;
  private helpButton: MRE.Actor;
  private choices: MRE.Actor;
  private userId: MRE.Guid;
  private userIds: Set<MRE.Guid>;

  private favoriteButtons = new Map<MRE.Guid, MRE.Actor>();
  private pollButtons = new Map<MRE.Guid, MRE.Actor>();

  private polls: { [key: string]: PollDescriptor } = {};

	constructor(public context: MRE.Context, public params: MRE.ParameterSet) {
	  this.assets = new MRE.AssetContainer(context);

    this.context.onStarted(() => this.started());
    this.context.onUserLeft(user => this.userLeft(user));
    this.context.onUserJoined(user => this.userJoined(user));
	}

	private async started() {
    UI.chooseBackgroundImage(this.params);
    this.screen = UI.createScreen(this);
    this.header = UI.createHeader(this);
    this.helpButton = UI.createHelpButton(this);
    UI.updateHeader(this.header, 'Title', 'We Are Bloom Poll');
    Audio.preload(this.assets);
		
    this.context.onUserJoined(async (user: MRE.User) => {
    this.userId = user.id;
    })
	}

  private startPoll(pollId: string, input: string){
    let inputs = input.split(SEPARATOR);
    let pollName = Utils.pollNameFrom(inputs);
    let choiceNames = Utils.choiceNamesFrom(inputs, MAX_CHOICES);

    // make sure audio assets are all loaded
    // only hosts can initiate this so there shouldn't be any crazy race conditions
    Audio.preload(this.assets);

    if(DEBUG)
      console.log(`inputs: ${inputs}, pollName: ${pollName}, choiceNames: ${choiceNames}`);

    // overrides existing polls
    this.polls[pollId] = {
      name: pollName,
      choices: []
    };

    let poll = this.polls[pollId];

    // by default, it's Yes or No
    if(choiceNames.length < 2){
      poll.choices.push({
        name: 'Yes',
        userIds: new Set<MRE.Guid>()
      });

      poll.choices.push({
        name: 'No',
        userIds: new Set<MRE.Guid>()
      });
    }
    else{
      // setup choices by name and index
      for (let i = 0; i < choiceNames.length; i++){
        poll.choices.push({
          name: choiceNames[i],
          userIds: new Set<MRE.Guid>()
        });
      }
    }

    UI.updateHeader(this.header, 'Results', `${poll.name}`);

    // recreate the screen controls
    this.choices = UI.recreateChoices(this, this.choices);
    this.wireUpControls(UI.updateChoices(this, poll, this.choices));

    // play a sound for everyone to let people know a new poll started
    Audio.playStartSound(this.assets, this.screen);

    UI.updateResults(this, poll, this.choices);

    if(DEBUG){
      console.log(`[Poll][Start] "${poll.name}" (${pollId})`);
      console.log(poll);
    }
  }

  private takePoll(user: MRE.User, response: number){
    let pollId = this.pollIdFor(user);
    let t = 0;

    if(pollId in this.polls){
      let poll = this.polls[pollId];
      for (let i = 0; i < poll.choices.length; i++) {
        if(i == response)
        {
          poll.choices[i].userIds.add(user.id);
        }
        else
        {
          poll.choices[i].userIds.delete(user.id);
        }
      }
        //UI.updateResults(this, poll, this.choices);
        const resultButton = MRE.Actor.CreateFromLibrary(this.context, {
        resourceId: 'artifact:1579239194507608147',
        actor: {
          name: 'Result Button',
          transform: {
            local: {
              position: { x: 1, y: .6, z: 0 }
            }
          },
          collider: { geometry: { shape: MRE.ColliderType.Box, size: { x: 0.5, y: 0.5, z: 0.5 } } },
          exclusiveToUser: this.userId
        }
       });
       resultButton.setBehavior(MRE.ButtonBehavior).onClick(user => {
        UI.updateResults(this, poll, this.choices);
       });
    }
}

  // could be from an Event or a World
  private pollIdFor(user: MRE.User) : string{
    let pollId : string;
    if(user.properties['altspacevr-event-id'])
      pollId = user.properties['altspacevr-event-id'];
    else
      pollId = user.properties['altspacevr-space-id'];
    return pollId;
  }

  // handles when user has no roles
  private canManagePolls(user: MRE.User) : boolean{
    let roles = user.properties['altspacevr-roles'].split(',');
    return roles && (roles.includes('moderator') || roles.includes('terraformer') || roles.includes('host'))
  }

  private userLeft(user: MRE.User) {
    // cleanup Favorite Button
    if(this.favoriteButtons.has(user.id)){
      this.favoriteButtons.get(user.id).destroy();
      this.favoriteButtons.delete(user.id);
    }

    // cleanup Poll Button
    if(this.pollButtons.has(user.id)){
      this.pollButtons.get(user.id).destroy();
      this.pollButtons.delete(user.id);
    }
  }

  private userJoined(user: MRE.User) {
    if(this.canManagePolls(user)){
      this.createPollButtonFor(user);
      if(this.params.content_pack){
        this.loadContentPack(this.params, user);
      }
      else if(this.params.poll){
        this.loadBundledPoll(this.params, user);
      }
    }
  }

  private createPollButtonFor(user: MRE.User){
    const position = { x: UI.HELP_BUTTON_POSITION.x - MAIN_BUTTON_SPACING, y: UI.HELP_BUTTON_POSITION.y, z: UI.HELP_BUTTON_POSITION.z }; // to the left of the help button
    const button = MRE.Actor.CreateFromLibrary(this.context, {
      resourceId: 'artifact:1579239603192201565', // https://account.altvr.com/kits/1579230775574790691/artifacts/1579239603192201565
      actor: {
        name: 'Poll Button',
        transform: { local: { position: position } },
        collider: { geometry: { shape: MRE.ColliderType.Box, size: { x: 0.5, y: 0.2, z: 0.01 } } },
        exclusiveToUser: user.id
      }
    });
    button.setBehavior(MRE.ButtonBehavior).onClick(user => {
      user.prompt(POLL_BUTTON_TEXT, true)
      .then(res => {
        if(res.submitted){
          if(res.text.length < 1)
            this.startPoll(this.pollIdFor(user), EXAMPLE);
          else
            this.startPoll(this.pollIdFor(user), res.text);
        }
        else{
          // user clicked 'Cancel'
        }
      })
      .catch(err => {
        console.error(err);
      });
    });
    this.pollButtons.set(user.id, button);
  }


  private createFavoritesButtonFor(context: MRE.Context, user: MRE.User, importedPolls: any){
    const position = { x: UI.HELP_BUTTON_POSITION.x - (MAIN_BUTTON_SPACING * 2), y: UI.HELP_BUTTON_POSITION.y, z: UI.HELP_BUTTON_POSITION.z }; // to the left of the poll button
    const favoritesButton = MRE.Actor.CreateFromLibrary(this.context, {
      resourceId: 'artifact:1579238678213952234', // https://account.altvr.com/kits/1579230775574790691/artifacts/1579238678213952234
      actor: {
        name: 'Favorites Button',
        transform: { local: { position: position } },
        collider: { geometry: { shape: MRE.ColliderType.Box, size: { x: 0.5, y: 0.2, z: 0.01 } } },
        exclusiveToUser: user.id
      }
    });
    favoritesButton.setBehavior(MRE.ButtonBehavior).onClick(user => {
      // toggling the Favorites
      if(this.favoriteButtons.has(user.id)){
        this.favoriteButtons.get(user.id).destroy();
        this.favoriteButtons.delete(user.id);
      }
      else{                             
        const favs = MRE.Actor.Create(this.context, {
          actor: {
            transform: {
              local: {
                position: { x: 2.3, y: 2.9, z: 0 },
                rotation: MRE.Quaternion.FromEulerAngles(0, 0 * MRE.DegreesToRadians, 0)
              }
            },
            exclusiveToUser: user.id
          }
        });

        // default, up to 8
        let y = -0.35;
        let buttonSpacing = 0.3;
        let choiceSpacing = 0.2;
        let height = 0.2;
        let scale = 1.0;

        // space out the buttons vertically based on the number of polls
        if(importedPolls.length > 8){ // up to 15
          y = -0.34;
          buttonSpacing = 0.15;
          choiceSpacing = 0.2;
          height = 0.2;
          scale = 0.5;
        }

        for(let i = 0; i < importedPolls.length; i++){
          let button = MRE.Actor.CreateFromLibrary(context, {
            resourceId: 'artifact:1579238678213952234', // https://account.altvr.com/kits/1579230775574790691/artifacts/1579238678213952234
            actor: {
              name: 'Favorite Button',
              transform: { local: { position: { x: 0, y: y, z: 0 }, scale: { x: scale, y: scale, z: scale } } },
              collider: { geometry: { shape: MRE.ColliderType.Box, size: { x: 0.5, y: 0.2, z: 0.01 } } },
              parentId: favs.id
            }
          });

          button.setBehavior(MRE.ButtonBehavior).onClick(user => {
            this.startPoll(this.pollIdFor(user), importedPolls[i].name + SEPARATOR + (importedPolls[i].choices.join(SEPARATOR)));
          });

          let text = importedPolls[i].name;

          if(importedPolls[i].answer)
            text += ` (${importedPolls[i].answer})`;

          let label = MRE.Actor.Create(context, {
            actor: {
              transform: { local: { position: { x: choiceSpacing, y: 0, z: 0 } } },
              text: {
                contents: text,
                height: height,
                anchor: MRE.TextAnchorLocation.MiddleLeft,
                justify: MRE.TextJustify.Left,
                font: UI.FONT
              },
              parentId: button.id
            }
          });

          y -= buttonSpacing;
        }

        this.favoriteButtons.set(user.id, favs);
      }
    });
  }


  /*
    Load Favorites from a Content Pack if you pass ?content_pack=<content_pack_id>

    Specify a url to a JSON file
    e.g. ws://10.0.1.119:3901?content_pack=1739750885568807748
    https://account.altvr.com/content_packs/1739750885568807748/raw.json

    {
      "favorites": [
        {
          "name": "Poll 1",
          "choices": [
            "one",
            "two"
          ]
        },
        ...
      ]
    }
  */
  private loadContentPack(params: MRE.ParameterSet, user: MRE.User){
    if(!params.content_pack){ return }
    let uri = 'https://account.altvr.com/api/content_packs/' + params.content_pack + '/raw.json';

    fetch(uri)
      .then((res: any) => res.json())
      .then((json: any) => {
        let importedPolls = Object.assign({}, json).favorites;
        if(!importedPolls){ return }
        this.createFavoritesButtonFor(this.context, user, importedPolls);
      })
  }

  // Load Favorites from the /polls folder if you pass ?poll=<name>
  // e.g. ws://10.0.1.119:3901?poll=quickstart
  private loadBundledPoll(params: MRE.ParameterSet, user: MRE.User){
    if(!params.poll){ return }

    let json = null;

    // handle if the poll doesn't exist
    try{
      json = require(`../polls/${params.poll}.json`);
    }
    catch{
      return;
    }

    if(DEBUG){ console.log(json) };

    let importedPolls = Object.assign({}, json).favorites;

    if(DEBUG){ console.log(importedPolls) };

    if(!importedPolls){ return }
    this.createFavoritesButtonFor(this.context, user, importedPolls);
  }

  private wireUpControls(buttons: MRE.Actor[]){
    for (let i = 0; i < buttons.length; i++){
      buttons[i].setBehavior(MRE.ButtonBehavior).onClick(user => {
        this.takePoll(user, i);
        Audio.playClickSound(this.assets, this.screen);
      });
    }
  }
}
