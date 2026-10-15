// English text of the parts of the flow designer that came with conditions and the Library: the call count, the condition box and its
// inspector, the checks of a rule in words, the pickers of an agent's prompt and output form, the fields on a line, and the new
// checks of a design. Merged into `en.ts`.

export const branchesEn = {
  // ---------- the most calls a round can make ----------
  'flow.calls': {
    one: 'up to {count} assistant call a round',
    other: 'up to {count} assistant calls a round',
  },
  'flow.calls.hint':
    'Every agent that takes part asks its assistant once. A branch that is skipped makes the real number lower.',

  // ---------- a condition ----------
  'flow.palette.condition': 'Condition',
  'flow.palette.conditionHint': 'Sends the design one way or the other, by what an agent answered.',
  'flow.palette.conditionCouncil':
    'A condition belongs to a design. Draw a line or add a writer to make this council a design first.',
  'flow.cond.kind': 'Condition',
  'flow.cond.name': 'Condition',
  'flow.cond.nameN': 'Condition {n}',
  'flow.cond.reads': 'Reads {name}',
  'flow.cond.noInput': 'Reads nothing yet',
  'flow.cond.noRules': 'No rule yet',
  'flow.cond.and': 'and',
  'flow.cond.or': 'or',
  'flow.cond.more': '+{count} more',
  'flow.cond.yes': 'Yes',
  'flow.cond.no': 'No',
  'flow.cond.yesTitle': 'Yes: the rules hold',
  'flow.cond.noTitle': 'No: the rules do not hold',
  'flow.cond.line': 'Condition · decided by code',
  'flow.cond.info':
    'Looks at the answer of one agent and sends the design down its Yes line or its No line. It is checked by code, at once: no assistant is asked.',
  'flow.cond.delete': 'Delete this condition',
  'flow.cond.readsTitle': 'Reads',
  'flow.cond.select': 'Select it',
  'flow.cond.inputNone':
    'Nothing is joined yet. Draw a line from an agent to this condition’s top dot. A report has no fields to check, so a report cannot be read.',
  'flow.cond.noFields': 'The form of this agent has no field a rule can check.',
  'flow.cond.rules': 'Rules',
  'flow.cond.mode': 'It is Yes when',
  'flow.cond.modeAll': 'All rules hold',
  'flow.cond.modeAny': 'Any rule holds',
  'flow.cond.noRulesYet': 'No rule yet. Add one: a field of the answer, a check and a value.',
  'flow.cond.noRulesNoInput': 'Join an agent first: its fields are what the rules check.',
  'flow.cond.addRule': 'Add a rule',
  'flow.cond.removeRule': 'Remove this rule',
  'flow.cond.field': 'Field',
  'flow.cond.check': 'Check',
  'flow.cond.value': 'Value',
  'flow.cond.pickField': 'Pick a field',
  'flow.cond.fieldGone': 'The input has no field “{field}” now. Pick another.',
  'flow.cond.valueBad.number': 'Write a number.',
  'flow.cond.valueBad.count': 'Write a whole number, 0 or more.',
  'flow.cond.valueBad.text': 'Write the text to compare with (at most 2,000 characters).',
  'flow.cond.valueBad.choice': 'Pick one of the field’s options.',
  'flow.cond.exits': 'Lines',
  'flow.cond.leadsTo': 'leads to {names}',
  'flow.cond.leadsNowhere': 'leads nowhere yet. Draw a line from its dot.',
  'flow.cond.failed':
    'If the agent failed or was skipped, or the field is missing or empty, the answer is No.',
  'flow.op.lt': 'less than',
  'flow.op.le': 'at most',
  'flow.op.gt': 'more than',
  'flow.op.ge': 'at least',
  'flow.op.eq': 'equals',
  'flow.op.ne': 'is not',
  'flow.op.empty': 'is empty',
  'flow.op.notEmpty': 'is not empty',
  'flow.op.contains': 'contains',
  'flow.op.equals': 'equals',
  'flow.op.true': 'is true',
  'flow.op.false': 'is false',
  'flow.op.is': 'is',
  'flow.op.isNot': 'is not',
  'flow.op.countLt': 'items: fewer than',
  'flow.op.countLe': 'items: at most',
  'flow.op.countGt': 'items: more than',
  'flow.op.countGe': 'items: at least',
  'flow.op.countEq': 'items: exactly',
  'flow.op.countNe': 'items: not',
  'flow.rule.empty': '{field} is empty',
  'flow.rule.notEmpty': '{field} is not empty',
  'flow.rule.contains': '{field} contains {value}',
  'flow.rule.equals': '{field} equals {value}',
  'flow.rule.true': '{field} is true',
  'flow.rule.false': '{field} is false',
  'flow.rule.is': '{field} is {value}',
  'flow.rule.isNot': '{field} is not {value}',
  'flow.rule.countLt': {
    one: '{field} has fewer than {value} item',
    other: '{field} has fewer than {value} items',
  },
  'flow.rule.countLe': {
    one: '{field} has at most {value} item',
    other: '{field} has at most {value} items',
  },
  'flow.rule.countGt': {
    one: '{field} has more than {value} item',
    other: '{field} has more than {value} items',
  },
  'flow.rule.countGe': {
    one: '{field} has at least {value} item',
    other: '{field} has at least {value} items',
  },
  'flow.rule.countEq': {
    one: '{field} has exactly {value} item',
    other: '{field} has exactly {value} items',
  },
  'flow.rule.countNe': {
    one: '{field} does not have {value} item',
    other: '{field} does not have {value} items',
  },
  'flow.receives.gateYes': 'Runs only when “{name}” says Yes',
  'flow.receives.gateNo': 'Runs only when “{name}” says No',

  // ---------- the pickers of an agent's prompt and output form ----------
  'flow.pick.builtin': 'Built-in',
  'flow.pick.openLibrary': 'Open in Library',
  'flow.pick.newFrom': 'New from this…',
  'flow.pick.showAll': 'Show all ({count} more)',
  'flow.pick.onlyFit': 'Only those that fit',
  'flow.pick.loading': 'Loading the Library…',
  'flow.pick.formHint':
    'The form says which fields the answer has. Only the forms that fit this place in the design are listed.',
  'flow.pick.promptHint':
    'The prompt is an entry of the Library: editing it there changes every model that uses it. Only prompts that fit this agent’s form and inputs are listed.',

  // ---------- a line of a condition, the fields on a line ----------
  'flow.edge.gateTitle': 'Line of a condition',
  'flow.edge.gateYes': '“{to}” runs only when “{from}” says Yes. This line carries no answer.',
  'flow.edge.gateNo': '“{to}” runs only when “{from}” says No. This line carries no answer.',
  'flow.edge.read': '“{to}” reads the answer of “{from}”.',
  'flow.edge.fields': 'Fields on this line',
  'flow.edge.onlyWhen': 'Only when',
  'flow.edge.always': 'Always',
  'flow.edge.whenChoice': '{name}: {exit}',
  'flow.edge.onlyYes': 'only if Yes',
  'flow.edge.onlyNo': 'only if No',
  'flow.problem.when': 'The line from “{name}” needs a valid condition and its Yes or No exit.',
  'flow.edge.fieldsAll': 'All fields',
  'flow.edge.fieldsSome': 'Choose fields',
  'flow.edge.fieldsAllHint': 'The whole answer goes along this line.',
  'flow.edge.fieldsHint':
    '“{to}” sees only the ticked fields of this answer, and nothing else of it.',
  'flow.edge.fieldsLast': 'A line carries at least one field.',
  'flow.edge.fieldCount': '{n} of {total} fields',
  'flow.edge.role': 'How “{to}” uses this answer',
  'flow.edge.roleRequired': 'Required',
  'flow.edge.roleGroup': 'One of the answers',
  'flow.edge.roleHint':
    'The two sides of a condition are alternatives: only one of them runs. Mark each as “One of the answers”, or the agent they reach is skipped whenever the other side runs.',

  // ---------- more checks, in words ----------
  'flow.problem.gate':
    'The line from “{name}” is not allowed: the Yes and No lines of a condition lead to an agent or to another condition.',
  'flow.problem.fields':
    'The line from “{name}” carries fields its answer does not have, or none. Choose its fields again.',
  'flow.problem.condInput':
    '“{name}” has to read exactly one agent whose answer has fields. A report has none.',
  'flow.problem.condRules': '“{name}” needs from 1 to 30 rules.',
  'flow.problem.condField':
    '“{name}” checks a field that “{source}” does not have. Pick the field again.',
  'flow.problem.condOperator':
    'A rule of “{name}” uses a check its field cannot have. Pick the check again.',
  'flow.problem.condValue': 'A rule of “{name}” has a value that is missing or not allowed.',
  'flow.problem.condExits': '“{name}” needs a line for Yes and a line for No.',
  'flow.refused.gateToOutput':
    'The Yes and No lines of a condition lead to an agent, not straight to the answer.',
  'flow.refused.conditionNeedsAgent':
    'A condition reads the answer of an agent. Your question has no fields to check.',
  'flow.refused.conditionNeedsFields':
    'A report is one piece of text with no fields to check. A condition reads an agent whose form has fields.',
  'flow.refused.conditionTaken':
    'A condition reads one agent only, and this one already reads another. Delete that line first.',
} as const;
