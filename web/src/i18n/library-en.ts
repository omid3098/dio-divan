// English text of the Library page (prompts and output forms) and of what the server refuses there. Merged into `en.ts`.

export const libraryEn = {
  'nav.library': 'Library',
  'councils.goal.library': 'go to Library',

  // ---------- the page ----------
  'library.tab.prompts': 'Prompts',
  'library.tab.forms': 'Output forms',
  'library.intro':
    'A prompt and an output form are written once here and used by any model. Editing one changes every model that uses it from then on; a session that has started keeps what it began with.',
  'library.loadFailed': 'The Library could not be loaded.',
  'library.yours': 'Your own',
  'library.builtin': 'Built-in',
  'library.newPrompt': 'New prompt',
  'library.newForm': 'New output form',
  'library.nonePrompts':
    'You have no prompts of your own yet. Start one, or duplicate a built-in prompt.',
  'library.noneForms':
    'You have no output forms of your own yet. Start one, or duplicate the Report form.',
  'library.untitled': 'Untitled',
  'library.notSaved': 'Not saved yet',
  'library.usedByCount': { one: 'Used by {count} model', other: 'Used by {count} models' },
  'library.fieldCount': { one: '{count} field', other: '{count} fields' },
  'library.anyForm': 'Any form',
  'library.inputs.any.short': 'any inputs',
  'library.inputs.with.short': 'with inputs',
  'library.inputs.without.short': 'no inputs',
  'library.inputs.any.label': 'Either',
  'library.inputs.with.label': 'With inputs',
  'library.inputs.without.label': 'Without inputs',
  'library.inputs.any.hint': 'Fits an agent whether or not other agents lead into it.',
  'library.inputs.with.hint':
    'Written for an agent that receives the answers of other agents, such as a chairman or a rewriter.',
  'library.inputs.without.hint': 'Written for an agent that answers the question on its own.',
  'library.emptyTitle': 'Nothing selected',
  'library.emptyPrompts': 'Pick a prompt from the list to read it, or start a new one.',
  'library.emptyForms': 'Pick an output form from the list to read it, or start a new one.',
  'library.missingTitle': 'This entry is not here',
  'library.missingText': 'It may have been deleted. Pick another one from the list.',

  // ---------- an entry ----------
  'library.name': 'Name',
  'library.namePlaceholder': 'Name this entry',
  'library.nameEmpty': 'Write a name.',
  'library.id': 'Id',
  'library.idHint': 'Models refer to the entry by this id:',
  'library.idBad':
    'An id starts with a lower-case letter and has letters, digits, - and _ (up to 48). It cannot be report, member or answer.',
  'library.idTaken': 'This id is already used.',
  'library.idFixed': 'Models refer to the entry by this id; it cannot be changed once it is saved.',
  'library.create': 'Make it',
  'library.copyOf': 'Copy of {name}',
  'library.newFromPrompt': 'New prompt from this',
  'library.newFromForm': 'New output form from this',
  'library.newFromPromptText':
    'A copy of “{name}” that you can edit. It has a name and an id of its own.',
  'library.newFromFormText':
    'A copy of “{name}” that you can edit. It has a name and an id of its own.',
  'library.duplicate': 'Duplicate',
  'library.saveFirst': 'Save or discard your changes first.',
  'library.builtinBadge': 'Built-in · read-only',
  'library.builtinNote': 'A built-in entry cannot be edited. Duplicate it to change a copy.',
  'library.builtinFormNote':
    'The member and final answer forms have nested fields, which the field builder cannot hold, so they cannot be duplicated. The Report form can.',
  'library.usedBy': 'Used by',
  'library.usedByNone': 'No model uses it yet.',
  'library.formPrompts': 'Prompts written for this form:',
  'library.prompt.divan.member': 'Member',
  'library.prompt.divan.chairman': 'Chairman',
  'library.prompt.divan.direct': 'Direct answer',
  'library.prompt.divan.report': 'Report writer',
  'library.prompt.divan.critic': 'Critic',

  // ---------- a prompt ----------
  'library.promptForm': 'Written for',
  'library.promptFormHint':
    'The output form this prompt is for. The pickers offer it to agents with that form, or to any agent when it says “Any form”.',
  'library.promptInputs': 'Inputs',
  'library.promptText': 'Prompt text',
  'library.promptPlaceholder': 'Write the prompt…',
  'library.promptTextHint': 'The whole text the agent is given as its instructions.',
  'library.promptCustomHint':
    'For a form of your own, Divan adds the list of its fields after your text.',

  // ---------- an output form ----------
  'library.fields': 'Fields',
  'library.fieldsHint':
    'The assistant must answer with exactly these fields. A field that is not required may be left empty (null).',
  'library.field.add': 'Add a field',
  'library.field.remove': 'Remove this field',
  'library.field.up': 'Move up',
  'library.field.down': 'Move down',
  'library.field.name': 'Field name',
  'library.field.type': 'Type',
  'library.field.required': 'Required',
  'library.field.description': 'Description',
  'library.field.descriptionPlaceholder': 'What this field holds, for the assistant',
  'library.field.maxWords': 'Word limit',
  'library.field.itemWords': 'Words per item',
  'library.field.min': 'Smallest',
  'library.field.max': 'Largest',
  'library.field.maxItems': 'Most items',
  'library.field.options': 'Options, one to a line',
  'library.optionsPlaceholder': 'pass\nfail',
  'library.type.text': 'Text',
  'library.type.markdown': 'Markdown',
  'library.type.number': 'Number',
  'library.type.boolean': 'Yes / no',
  'library.type.choice': 'Choice',
  'library.type.list': 'List',
  'library.type.string': 'Text',
  'library.type.integer': 'Whole number',
  'library.type.array': 'List',
  'library.type.object': 'Nested fields',
  'library.fieldProblem.name':
    'A field name has lower-case letters, digits and _, starts with a letter and has up to 32 characters.',
  'library.fieldProblem.duplicate': 'Two fields have this name.',
  'library.fieldProblem.description': 'The description is too long (at most 2,000 characters).',
  'library.fieldProblem.maxWords': 'The word limit is a whole number from 1 to 8,000.',
  'library.fieldProblem.maxItems': 'The most items is a whole number from 0 to 100.',
  'library.fieldProblem.bounds':
    'The smallest number is above the largest, or a number is too large.',
  'library.fieldProblem.options':
    'A choice needs from 1 to 50 different options, each up to 200 characters.',
  'library.schema.title': 'JSON Schema sent to the assistants',
  'library.schema.hint':
    'This is what the server gives the assistants for this form. Limits on words, numbers and items are not in it: Divan checks them itself when the answer comes back.',

  // ---------- saving and deleting ----------
  'library.blocker.name': 'Write a name to save.',
  'library.blocker.id': 'Fix the id to save.',
  'library.blocker.prompt': 'Write the prompt text (up to 64,000 characters) to save.',
  'library.blocker.fields': 'Fix the fields to save.',
  'library.save': 'Save',
  'library.saved':
    'Saved. Models that use it take the change from now on; sessions already started keep what they began with.',
  'library.conflict': '“{name}” was changed somewhere else. Your edits are still here.',
  'library.conflictLoad': 'Load the other version',
  'library.conflictKeep': 'Keep my version',
  'library.reloadTitle': 'Load the other version?',
  'library.reloadText': 'Your edits to this entry are thrown away and cannot be brought back.',
  'library.deleteTitle': 'Delete this entry?',
  'library.deleteText': '“{name}” is deleted. This cannot be undone.',
  'library.inUse.title': 'This entry is in use',
  'library.inUse.text': '“{name}” cannot be deleted while something uses it.',
  'library.inUse.models': 'Models that use it',
  'library.inUse.prompts': 'Prompts written for this form',
  'library.inUse.how': 'Take it out of those models (or delete those prompts), then delete it.',
  'library.inUse.close': 'Close',
  'library.goal.new': 'start a new entry',

  // ---------- what the server refuses, in plain words ----------
  'library.reason.entry_id': 'The id is not allowed.',
  'library.reason.entry_name': 'The name is empty or longer than 100 characters.',
  'library.reason.entry_revision': 'The revision of the entry is not valid.',
  'library.reason.prompt_form': 'The form this prompt is written for is not valid.',
  'library.reason.prompt_inputs': 'The inputs setting of this prompt is not valid.',
  'library.reason.prompt_text': 'The prompt text is empty or longer than 64,000 characters.',
  'library.reason.prompt_form_missing':
    'The form this prompt is written for is not in the Library.',
  'library.reason.form_fields': 'A form has from 1 to 30 fields.',
  'library.reason.field_name':
    'A field name is not allowed or is used twice: use lower-case letters, digits and _, starting with a letter.',
  'library.reason.field_type': 'A field has a type that is not allowed.',
  'library.reason.field_description': 'A description is longer than 2,000 characters.',
  'library.reason.field_limit': 'A word limit or an item limit is outside what is allowed.',
  'library.reason.field_bounds':
    'The smallest number is above the largest, or a number is too large.',
  'library.reason.field_limit_type': 'A field has a limit that its type does not allow.',
  'library.reason.field_options':
    'A choice needs from 1 to 50 different options, each up to 200 characters.',
  'library.reason.form_size': 'The form is too large.',
  'library.reason.builtin_form_not_flat':
    'This built-in form has nested fields (lists of objects), which the field builder cannot hold, so it cannot be duplicated. Start a new form and add its fields, or duplicate the Report form.',
  'library.reason.other': 'The server did not accept it ({reason}).',
} as const;
