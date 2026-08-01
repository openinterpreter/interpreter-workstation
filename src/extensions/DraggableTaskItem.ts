import TaskItem from '@tiptap/extension-task-item';

/**
 * Extended TaskItem that supports drag-and-drop reordering.
 * The checkbox/label acts as the drag handle.
 */
export const DraggableTaskItem = TaskItem.extend({
  draggable: true,

  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor }) => {
      const listItem = document.createElement('li');
      const checkbox = document.createElement('input');
      const label = document.createElement('label');
      const content = document.createElement('div');

      // Apply attributes
      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          listItem.setAttribute(key, String(value));
        }
      });

      listItem.dataset.type = 'taskItem';
      listItem.dataset.checked = node.attrs.checked ? 'true' : 'false';

      // Setup checkbox
      checkbox.type = 'checkbox';
      checkbox.checked = node.attrs.checked;
      checkbox.contentEditable = 'false';

      // Handle checkbox toggle
      checkbox.addEventListener('change', () => {
        if (typeof getPos === 'function') {
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.chain().command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                checked: checkbox.checked,
              });
              return true;
            }).run();
          }
        }
      });

      // Setup label as drag handle
      label.contentEditable = 'false';
      label.draggable = true;
      label.appendChild(checkbox);

      // Make the label the drag handle
      label.addEventListener('dragstart', (event) => {
        if (typeof getPos === 'function') {
          const pos = getPos();
          if (typeof pos === 'number' && event.dataTransfer) {
            // Set the drag data for ProseMirror
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', ''); // Required for Firefox

            // Trigger ProseMirror's internal drag handling
            const view = editor.view;
            const coords = { left: event.clientX, top: event.clientY };
            const posAtCoords = view.posAtCoords(coords);

            if (posAtCoords) {
              // Select the node to enable ProseMirror drag
              editor.commands.setNodeSelection(pos);
            }
          }
        }
      });

      // Content div for the text
      content.setAttribute('data-node-view-content', '');

      listItem.appendChild(label);
      listItem.appendChild(content);

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'taskItem') {
            return false;
          }

          checkbox.checked = updatedNode.attrs.checked;
          listItem.dataset.checked = updatedNode.attrs.checked ? 'true' : 'false';

          return true;
        },
      };
    };
  },
});
