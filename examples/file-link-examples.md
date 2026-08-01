# File Link Examples

This document demonstrates how file links appear in agent responses.

## Example 1: Single File Reference

**Agent Response:**
```
I've updated the configuration in [package.json](/Users/example/Projects/interpreter-workstation/package.json)
```

**How it renders:**
- The text "I've updated the configuration in " appears as normal text
- "package.json" renders as an inline FileSystemProxy component with:
  - A small file thumbnail icon
  - The filename "package.json"
  - A border and background to make it stand out
  - Hover shows the full path: `/Users/example/Projects/interpreter-workstation/package.json`
- When clicked, it opens the file in a new editor tab

## Example 2: Multiple File References

**Agent Response:**
```
I've made changes to three files:
- [App.tsx](/Users/example/Projects/interpreter-workstation/src/App.tsx)
- [MarkdownText.tsx](/Users/example/Projects/interpreter-workstation/agent/components/assistant-ui/MarkdownText.tsx)
- [remarkFileLinks.ts](/Users/example/Projects/interpreter-workstation/agent/components/assistant-ui/remarkFileLinks.ts)
```

**How it renders:**
- Each filename in the list appears as an inline FileSystemProxy
- All are clickable and show file thumbnails
- Clean, consistent styling throughout

## Example 3: Directory Reference

**Agent Response:**
```
I've created new files in the [tests](/Users/example/Projects/interpreter-workstation/tests) directory
```

**How it renders:**
- "tests" renders as an inline FileSystemProxy with:
  - A folder icon (instead of file thumbnail)
  - The directory name "tests"
  - When clicked, could expand the directory in explorer (future enhancement)

## Example 4: Mixed Content

**Agent Response:**
```
Check out the [FileSystemProxy component](https://github.com/assistant-ui/assistant-ui) for inspiration,
then update [src/components/FileSystemProxy.tsx](/Users/example/Projects/interpreter-workstation/src/components/FileSystemProxy.tsx)
```

**How it renders:**
- "FileSystemProxy component" renders as a normal blue hyperlink (external URL)
- "src/components/FileSystemProxy.tsx" renders as an inline FileSystemProxy component
- The system correctly differentiates between external links and file paths

## Visual Comparison

### Before (Plain Link):
```
[package.json](/path/to/package.json)
```
Would render as: package.json (blue underlined hyperlink)
Clicking would: Try to navigate to `/path/to/package.json` as a URL (broken)

### After (FileSystemProxy):
```
[package.json](/path/to/package.json)
```
Renders as: 📄 package.json (in a subtle bordered box with file icon)
Clicking will: Open the file in the editor
Hovering shows: Full path in tooltip

## Code Examples

### Example Response from LLM

```markdown
I've refactored the authentication logic. The main changes are in:

1. [auth.ts](/Users/user/project/src/services/auth.ts) - Added JWT token validation
2. [middleware.ts](/Users/user/project/src/middleware.ts) - Updated authentication middleware
3. [config](/Users/user/project/config) - New configuration directory with auth settings

You should also check the official documentation at [https://jwt.io](https://jwt.io) for more details on JWT.
```

### How This Renders

- Lines 1-2: Normal markdown text
- Line 4: `auth.ts` appears as inline file component (clickable)
- Line 5: `middleware.ts` appears as inline file component (clickable)
- Line 6: `config` appears as inline directory component (folder icon)
- Line 8: Regular blue hyperlink to jwt.io (not transformed)

## Benefits

1. **Visual Clarity**: Files stand out from regular text and links
2. **Consistent UX**: Same component used throughout the app (tabs, explorer, mentions)
3. **Quick Access**: One click to open the referenced file
4. **Context**: Tooltip shows full path
5. **Smart Detection**: Automatically differentiates files, directories, and URLs

## Usage Tips for LLMs

When responding to users, you can now reference files naturally:

✅ Good:
```markdown
I've updated [config.json](/absolute/path/to/config.json)
```

✅ Also Good:
```markdown
Check the [src/components](/absolute/path/to/src/components) folder
```

❌ Won't Work (relative path):
```markdown
See [./config.json](./config.json)
```

❌ Won't Work (not a path):
```markdown
Visit [GitHub](github.com)
```
