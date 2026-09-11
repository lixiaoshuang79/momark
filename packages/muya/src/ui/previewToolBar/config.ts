import DeleteIcon from '../../assets/icons/delete/2.png';
import EditIcon from '../../assets/icons/edit.png';
import SidebarIcon from '../../assets/icons/sidebar.png';

export default [
    {
        type: 'edit',
        tooltip: 'edit',
        icon: EditIcon,
    },
    {
        type: 'delete',
        tooltip: 'delete block',
        icon: DeleteIcon,
    },
    {
        // HTML blocks only (the math block toolbar filters it out): renders
        // the embedded page in the right side panel.
        type: 'open-sidebar',
        tooltip: 'open in side panel',
        icon: SidebarIcon,
    },
];
