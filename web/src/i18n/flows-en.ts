// English text of the flow designer on the Councils page. Merged into `en.ts`. The words in a message that are about a box
// are the box's own name (what the user called it, else its role); no sentence here says who wrote an anonymous answer.

export const flowsEn = {
  // ---------- starting a design ----------
  'flow.template.single.hint':
    'One assistant answers the question directly. Start from here to build your own structure.',
  'flow.role.assistant': 'Assistant',
  'flow.startFrom': 'Start from',
  'flow.template.council.hint':
    'Today’s council: several agents answer on their own and without names; a chairman writes the answer.',
  'flow.template.writer-critics.hint':
    'One agent writes a draft with its tools. Critics answer about the draft without names. A second agent rewrites it into the answer.',

  // ---------- the page ----------
  'flow.designBadge': 'Design',
  'flow.councilBadge': 'Council',
  'flow.levelNote':
    'Design edits are made on Base. Here you can change an agent’s model and effort or switch it off, for {level} only.',

  // ---------- the canvas ----------
  'flow.canvas': 'Design canvas',
  'flow.palette': 'Add',
  'flow.palette.agent': 'Agent',
  'flow.palette.member': 'Member',
  'flow.palette.writer': 'Writer',
  'flow.palette.writerHint':
    'A writer drafts a report for the chairman. It is not a member, so the council becomes a design.',
  'flow.palette.fullMembers': 'A council has at most {max} members.',
  'flow.palette.input': 'Input',
  'flow.palette.output': 'Output',
  'flow.palette.there': 'already there',
  'flow.palette.full': 'A design has at most {max} boxes.',
  'flow.fit': 'Fit the whole design in view',
  'flow.arrange': 'Arrange the boxes',
  'flow.input.kind': 'Input',
  'flow.input.name': 'Your question',
  'flow.input.sub': '+ the conversation so far',
  'flow.output.kind': 'Output',
  'flow.output.name': 'The answer',
  'flow.output.sub': 'Recommendation and questions',
  'flow.form.report': 'Report',
  'flow.form.member': 'Member answer',
  'flow.form.answer': 'Final answer',
  'flow.role.member': 'Member',
  'flow.role.writer': 'Writer',
  'flow.role.critic': 'Critic',
  'flow.role.chairman': 'Chairman',
  'flow.role.rewriter': 'Rewriter',
  'flow.shortage': '{n} more member models needed',
  'flow.group': 'At least {min} of {of} · anonymous',
  'flow.required': 'Draft · required',
  'flow.readOnly': 'read-only',
  'flow.offAtLevel': 'Off at {level}',
  'flow.changedHere': 'Changed for this level',
  'flow.off': 'off',
  'flow.switchedOff': 'Off',

  // ---------- the inspector ----------
  'flow.inspector': 'Inspector',
  'flow.empty.title': 'Select an agent',
  'flow.empty.text': 'Its model, access and prompt are edited here.',
  'flow.agentLine.report': 'Agent · writes a report',
  'flow.agentLine.member': 'Agent · answers as a member',
  'flow.agentLine.answer': 'Agent · gives the final answer',
  'flow.name': 'Name',
  'flow.name.placeholder': 'Name of this agent',
  'flow.receives': 'Receives',
  'flow.receives.context': 'The conversation so far',
  'flow.receives.contextNote': 'sent automatically',
  'flow.receives.question': 'Your question',
  'flow.receives.questionNote': 'from Input',
  'flow.receives.draft': 'Draft from {name}',
  'flow.receives.draftNote': 'required',
  'flow.group.title': { one: 'Answer from {count} agent', other: 'Answers from {count} agents' },
  'flow.group.use': 'Use at least',
  'flow.group.of': 'of {n}',
  'flow.group.fewer': 'Wait for fewer answers',
  'flow.group.more': 'Wait for more answers',
  'flow.group.anonymous': 'Who wrote each answer is hidden: the letters are shuffled every round.',
  'flow.group.rule':
    'Starts when all are done, or when at least {min} have answered and the rest are done.',
  'flow.runsOn': 'Runs on',
  'flow.access': 'Access',
  'flow.access.readonly': 'Read-only · never writes',
  'flow.access.webFinal': 'Web is closed for the agent that gives the final answer.',
  'flow.outputForm': 'Output form',
  'flow.formHint.report': 'Free notes in Markdown, for the next agent to read.',
  'flow.formHint.member': 'A short structured answer: position, recommendation, claims and risks.',
  'flow.formHint.answer':
    'The answer you get: title, recommendation and questions. Only this form can feed Output.',
  'flow.formFeedsOutput': 'This agent feeds Output, so its form has to be Final answer.',
  'flow.prompt': 'System prompt',
  'flow.prompt.undo': 'Undo changes to the prompt',
  'flow.deleteAgent': 'Delete this agent',
  'flow.base.takesPart': 'Takes part',
  'flow.base.off': 'Switched off: it stays here but is not asked. A level can switch it on again.',
  'flow.level.title': 'At {level}',
  'flow.level.takesPart': 'Takes part at this level',
  'flow.level.off': 'Switched off at this level; the design still has it.',
  'flow.level.fixed': 'Everything else about this agent is set on Base.',
  'flow.level.alwaysOn': 'The agent that gives the final answer always takes part.',
  'flow.level.derived': 'The level sets the effort; change it here for this agent only.',
  'flow.inputInfo':
    'Where each round starts: the question you ask. Agents that no other agent feeds get it from here; every agent also reads the conversation so far.',
  'flow.outputInfo':
    'What you get: the answer of the one agent that gives the final answer, with its title, recommendation and questions.',
  'flow.edge.title': 'Connection',
  'flow.edge.ends': '{from} to {to}',
  'flow.edge.input': 'Sends your question to {to}.',
  'flow.edge.required': '{to} needs this draft before it starts.',
  'flow.edge.group': 'One of the answers {to} waits for.',
  'flow.edge.output': 'Gives the answer.',
  'flow.edge.delete': 'Delete connection',

  // ---------- a council on the canvas ----------
  'flow.council.note':
    'A line between boxes, or a writer, makes this council a design. Every other change here keeps it a council.',
  'flow.council.noteQuick':
    'Quick follows the speed of your assistants, so it cannot become a design. Duplicate it to design one.',
  'flow.council.noEffort':
    'The base council has no effort of its own: each reasoning level sets it.',
  'flow.council.defaultMember': 'One of Divan’s default members. Switch it off to leave it out.',
  'flow.council.minimum': 'A council waits for two answers. Any other number makes it a design.',
  'flow.council.formTitle': 'Form and prompt',
  'flow.council.form':
    'Every member uses Divan’s standard answer form and system prompt, and the chairman its own. To change them, make this council a design.',
  'flow.council.makeDesign': 'Make it a design…',
  'flow.council.quickCannot': 'Quick cannot become a design. Duplicate it to design one.',
  'flow.convert.title': 'Make this council a design?',
  'flow.convert.text':
    'This council becomes a design. At {level} a design keeps all its steps and only lowers efforts; a council turns its slowest member off.',
  'flow.convert.limits':
    'Its answer limits ({claims} claims per member, {words} words per claim) give way to the standard member form.',
  'flow.convert.saved':
    'Nothing is saved until you press Save. “Discard changes” brings the council back.',
  'flow.convert.continue': 'Continue',

  // ---------- settings of the whole council ----------
  'flow.settings.open': 'Settings of this model',
  'flow.settings.title': 'Model settings',
  'flow.settings.titleDesign': 'Design settings',
  'flow.settings.purposeDesign':
    'The agents, lines and prompts that answer when you ask with this design.',
  'flow.settings.assistants': 'Assistants on this PC',
  'flow.settings.allUsable': 'Every assistant Divan knows is available on this PC.',
  'flow.settings.resetHintDesign':
    'Takes the design away and removes every saved change, in the base and in all levels. The model goes back to the automatic council structure.',
  'flow.settings.resetTextDesign':
    '“{name}” stops being a design: its agents, lines and prompts and every level change are removed, and it goes back to the automatic council settings. This cannot be undone.',

  // ---------- checks ----------
  'flow.valid': 'Design is valid',
  'flow.problem.title': 'Needs attention',
  'flow.problem.show': 'Show',
  'flow.fixToSave': 'Fix the design to save.',
  'flow.problem.format': 'The design cannot be read.',
  'flow.problem.size': 'A design has from 3 to 18 boxes and at most 80 lines.',
  'flow.problem.id': '“{name}” has an id that is not allowed or is used twice.',
  'flow.problem.kind': '“{name}” is not a kind of box a design can have.',
  'flow.problem.oneIO': 'A design has exactly one Input and one Output.',
  'flow.problem.edge': 'A line points at a box that is not there, or repeats another line.',
  'flow.problem.connection': 'Output cannot send anything on, and nothing can be sent to Input.',
  'flow.problem.lost':
    '“{name}” is not connected: it needs a way in from Input and a way out that leads to Output.',
  'flow.problem.lostMany': {
    one: '“{name}” and {count} more box are not connected: each needs a way in from Input and a way out that leads to Output.',
    other:
      '“{name}” and {count} more boxes are not connected: each needs a way in from Input and a way out that leads to Output.',
  },
  'flow.problem.cycle':
    'These agents feed each other in a loop: {names}. A rewrite is a second agent, not a line back.',
  'flow.problem.final':
    'Exactly one agent gives the final answer, and Output takes the answer of that agent. Set its form to Final answer and join it to Output.',
  'flow.problem.finalWeb': '“{name}” gives the final answer, so its Web switch has to stay off.',
  'flow.problem.model': 'Pick a model for “{name}”.',
  'flow.problem.prompt': '“{name}” needs a system prompt.',
  'flow.problem.agent': '“{name}” has a setting that is missing or not allowed.',
  'flow.problem.role': '“{name}” has a role that does not fit its output form.',
  'flow.problem.size.agent': 'The prompt of “{name}” is too long (at most 64,000 characters).',
  'flow.problem.dependency': 'What feeds “{name}” does not match its lines. Draw the lines again.',
  'flow.problem.minimum': '“{name}” waits for more answers than there are agents feeding it.',
  'flow.problem.disabled': '“{name}” needs an agent that is switched off.',
  'flow.problem.critic': '“{name}” reads a draft, so only a report agent can feed it that way.',
  'flow.problem.disabledOutput': 'The agent that gives the final answer cannot be switched off.',
  'flow.problem.access': '“{name}”: {reason}',
  'flow.problem.atLevel': 'At {level}: {problem}',

  // ---------- a line that is refused ----------
  'flow.refused.self': 'A box cannot feed itself.',
  'flow.refused.missing': 'That line has nowhere to go.',
  'flow.refused.fromOutput': 'Output is the end: nothing leaves it.',
  'flow.refused.toInput': 'Input is the start: nothing can be sent to it.',
  'flow.refused.duplicate': 'These two boxes are already joined.',
  'flow.refused.outputNeedsAnswer':
    'Only the agent that gives the final answer can feed Output. Set its form to Final answer first.',
  'flow.refused.outputTaken':
    'Output already takes its answer from another agent. Delete that line first.',
  'flow.refused.inputRedundant':
    'Every agent reads your question and the conversation already; an agent that other agents feed needs no line from Input.',
  'flow.refused.answerFeedsAgent':
    'The final answer ends the design: only Output can take it. A rewrite is a second agent.',
  'flow.refused.cycle':
    'That line would make a loop: a design runs forwards only. A rewrite is a second agent.',
  'flow.refused.dismiss': 'Dismiss',
} as const;
