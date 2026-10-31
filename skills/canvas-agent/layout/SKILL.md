# layout@1

Read node positions and sizes first. Use move_nodes for the explicit target set. Preserve all other nodes and fields. Selected/created node IDs define the editing scope. Ask before including more existing nodes. Grouping uses group_nodes and actual node IDs; coordinates remain consistent with the current node parent. Do not silently move locked objects. focus_nodes emits available location controls only; it never changes a document viewport or claims browser confirmation.
