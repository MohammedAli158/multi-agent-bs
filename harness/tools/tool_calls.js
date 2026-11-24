/**
 * ============================================================================
 * harness/tools/tool_calls.js  —  THE MENU THE MODEL READS
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Exports `tools`: a JSON list describing every capability the agent has.
 * We hand this array to the LLM on EVERY request. The model reads the names,
 * descriptions and parameter schemas, then decides which (if any) to call.
 *
 * YOU NEVER CALL THESE FUNCTIONS DIRECTLY. The model does, by emitting a
 * `tool_calls` array in its reply. We then look the name up in the dispatch
 * table (toolExecute.js) and run it.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT MATTERS — PICK ONE AND STICK WITH IT
 * ---------------------------------------------------------------------------
 * Chat Completions API (what we use — chat.completions.create):
 *     { type: "function",
 *       function: { name, description, parameters } }      <-- NESTED
 *
 * Responses API (responses.create) — what your original code had:
 *     { type: "function", name, description, parameters }  <-- FLAT
 *
 * Mixing them up produces confusing errors, because the API silently ignores
 * fields it doesn't recognise and then complains it has "no tools".
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON `strict` AND SCHEMAS
 * ---------------------------------------------------------------------------
 * `parameters` is a JSON Schema. The model is told to produce arguments that
 * validate against it. Properties you mark in `required` MUST be supplied or
 * the model (in strict mode) will be forced to ask you for them.
 * Keep schemas small — every token here is re-sent on every single turn.
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {object} ToolSpec
 * @property {"function"} type
 * @property {{name:string, description:string, parameters:object}} function
 */

/** @type {ToolSpec[]} */
export const tools = [
  // ==========================================================================
  // 1. SHELL — the whole reason this project exists
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        'Execute a shell command inside the session sandbox and return its ' +
        'stdout, stderr and exit code. Use this to run builds, tests, package ' +
        'managers, scripts and any CLI tool. Commands time out and are ' +
        'restricted for safety.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The command line to execute, e.g. "npm install" or "node test.js". ' +
              'Standard shell syntax (pipes, &&, redirects) is supported.',
          },
          timeout: {
            type: 'number',
            description:
              'Optional timeout in seconds (1-600). Defaults to 120.',
            minimum: 1,
            maximum: 600,
          },
        },
        required: ['command'],
      },
    },
  },

  // ==========================================================================
  // 2. READ A FILE
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Returns numbered lines. Use ' +
        'offset/limit to read large files in slices instead of loading ' +
        'everything at once.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the workspace root, e.g. "src/index.js"',
          },
          offset: {
            type: 'number',
            description: '1-based line number to start reading from (default 1).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to return (default 2000).',
          },
        },
        required: ['path'],
      },
    },
  },

  // ==========================================================================
  // 3. WRITE A FILE (create or fully overwrite)
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file or completely overwrite an existing one. Parent ' +
        'directories are created automatically. For changing part of an ' +
        'existing file, use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          content: { type: 'string', description: 'The full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },

  // ==========================================================================
  // 4. EDIT A FILE (surgical replacement)
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace exact text in an existing file. old_string must match ' +
        'EXACTLY (including whitespace and indentation) and must be unique ' +
        'in the file unless replace_all is true. Use this for precise edits; ' +
        'use write_file for new files or full rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the workspace root.' },
          old_string: {
            type: 'string',
            description: 'The exact text to find. Must be unique unless replace_all.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text. May be empty to delete old_string.',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of only the first (default false).',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },

  // ==========================================================================
  // 5. FIND FILES BY NAME
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern. Supports * (within a segment), ' +
        '** (across directories) and ? (single char). Example: "**/*.js"',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.test.js"' },
          path: {
            type: 'string',
            description: 'Directory to search from, relative to workspace (default ".")',
          },
        },
        required: ['pattern'],
      },
    },
  },

  // ==========================================================================
  // 6. SEARCH INSIDE FILES
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents with a regular expression. Returns ' +
        '"path:line: text" for each match.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: {
            type: 'string',
            description: 'File or directory to search (default "." = whole workspace).',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Match case-insensitively (default false).',
          },
        },
        required: ['pattern'],
      },
    },
  },

  // ==========================================================================
  // 7. LIST A DIRECTORY
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the contents of a directory (names, sizes, and a trailing / ' +
        'for folders).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default "." = workspace root).' },
          include_hidden: {
            type: 'boolean',
            description: 'Include dotfiles (default false).',
          },
        },
        required: [],
      },
    },
  },

  // ==========================================================================
  // 8. WEB SEARCH (runs on the HOST, never inside the sandbox)
  // ==========================================================================
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the internet and return titles, URLs and snippets. Use this ' +
        'when you need current information you cannot know from training.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          max_results: {
            type: 'number',
            description: 'How many results to return, 1-20 (default 10).',
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * Quick lookup: name -> schema.
 * The dispatcher uses this to validate that a tool call names a REAL tool
 * before we try to run anything.
 */
export const toolNames = new Set(tools.map((t) => t.function.name));
