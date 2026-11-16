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
        // HTML blocks only (the math block toolbar filters it out): opens the
        // embedded page side by side with the document.
        type: 'open-side-by-side',
        tooltip: 'open side by side',
        icon: SidebarIcon,
    },
];
