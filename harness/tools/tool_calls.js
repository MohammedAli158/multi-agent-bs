// {
//   "model": "gpt-5.6-terra",
//   "messages": [
//     {
//       "role": "user",
//       "content": "What is the weather like in Boston today?"
//     }
//   ],


  export const tools  =  [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read the file with given offset and limit",
        "parameters": {
          "type": "object",
          "properties": {
            "offset": {
              "type": "integer",
              "description": "The starting line from where you want to read the file"
            },
            "limit": {
              "type": "integer",
              "description": "The number of lines from starting line, including starting line you want to read"
            },
            "path": {
              "type": "string",
              "description": "The path to the file you want to read"
            }
          },
          "required": ["path"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "edit_file",
        "description":   `Edit a file by replacing text. The old_string must match exactly 
        (including whitespace and indentation) and must be unique in the file 
        unless replace_all is true. Use this for precise, surgical edits. 
        For creating new files or complete rewrites, use write_file instead.`,
        "parameters": {
          "type": "object",
          "properties": {
            "old_string": {
              "type": "string",
              "description": "The exact text to find and replace. Must match exactly including all whitespace and indentation. For new files, leave this empty."
            },
            "path": {
              "type": "string",
              "description": "The path to the file you want to write"
            },
            "new_string": {
              "type": "string",
              "description": "The text to replace old_string with. Can be empty to delete text. For new files, this is the text to write."
            },
            "replace_all": {
              "type": "boolean",
              "description": "Whether to replace all occurrences of old_string or just the first one. Default is false."
            }
          },
          "required": ["path"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "write_file",
        "description": `Write content to a file. Creates the file if it doesn't exist, 
        or overwrites if it does. Parent directories are created automatically. Use this for creating new files or completely replacing file contents. For partial modifications, use the edit tool instead.`,
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "The path to the file you want to write"
            },
            "content": {
              "type": "string",
              "description": "Content to write to the file"
            },
            "create_directories": {
              "type": "boolean",
              "description": "create parent directories if they dont exist"
            }
          },
          "required": ["path","content"]
        }
      }
    },
    {
    "type": "function",
    "function": {
      "name": "glob",
      "description": "Find files matching a glob pattern. Supports ** for recursive matching.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Glob pattern to match"
          },
          "path": {
            "type": "string",
            "description": "Directory to search in (default: current directory)",
            "default": "."
          }
        },
        "required": ["pattern"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "grep",
      "description": "Search for a regex pattern in file contents. Returns matching lines with file paths and line numbers.",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Regular expression pattern to search for"
          },
          "path": {
            "type": "string",
            "description": "File or directory to search in (default: current directory)",
            "default": "."
          },
          "case_insensitive": {
            "type": "boolean",
            "description": "Case-insensitive search (default: false)",
            "default": false
          }
        },
        "required": ["pattern"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "shell",
      "description": "Execute a shell command. Use this for running system commands, scripts and CLI tools.",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "The shell command to execute"
          },
          "timeout": {
            "type": "integer",
            "description": "Timeout in seconds (default: 120)",
            "default": 120,
            "minimum": 1,
            "maximum": 600
          },
          "cwd": {
            "type": "string",
            "description": "Working directory for the command"
          }
        },
        "required": ["command"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_dir",
      "description": "List contents of a directory",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Directory path to list (default: current directory)",
            "default": "."
          },
          "include_hidden": {
            "type": "boolean",
            "description": "Whether to include hidden files and directories (default: false)",
            "default": false
          }
        },
        "required": []
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Search the web for information. Returns search results with titles, URLs and snippets",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Search query"
          },
          "max_results": {
            "type": "integer",
            "description": "Maximum results to return (default: 10)",
            "default": 10,
            "minimum": 1,
            "maximum": 20
          }
        },
        "required": ["query"]
      }
    }
  }
  ]

