# Swimming Pool Schedule Management System - Design Guidelines

## Design Approach: Material Design System

**Rationale**: This is a utility-focused schedule management application requiring clarity, efficiency, and professional presentation. Material Design provides the necessary structure for data-dense interfaces while maintaining clean aesthetics.

**Core Principles**:
- Information clarity over visual flourish
- Efficient task completion
- Consistent, predictable interactions
- Professional administrative interface

---

## Typography System

**Font Family**: Inter (via Google Fonts CDN)

**Type Scale**:
- Page Headers: 32px, Semi-bold (600)
- Section Headers: 24px, Semi-bold (600)
- Card/Component Titles: 18px, Medium (500)
- Body Text: 16px, Regular (400)
- Caption/Meta: 14px, Regular (400)
- Notification Title: 16px, Medium (500)
- Notification Body: 14px, Regular (400)
- Button Text: 14px, Medium (500)

---

## Layout & Spacing System

**Spacing Units**: Tailwind 2, 3, 4, 6, 8, 12, 16, 24 units
- Tight spacing: 2-3 units (between related elements)
- Component padding: 4-6 units
- Section margins: 8-12 units
- Page padding: 16-24 units

**Container Widths**:
- Main content area: max-w-7xl
- Schedule grids: Full width within container
- Forms/dialogs: max-w-2xl

---

## Notification Component Specifications

### Positioning & Structure
- Fixed position at top-right corner
- Top offset: 96px from viewport top
- Right offset: 24px from viewport edge
- Width: 400px
- z-index: 50 (floats above content)

### Visual Treatment
- Background: Pure white (#FFFFFF)
- Border radius: 12px (rounded-xl)
- Shadow: Large elevation shadow (0 10px 25px rgba(0,0,0,0.1), 0 4px 12px rgba(0,0,0,0.08))
- Border: 1px solid rgba(0,0,0,0.06) for subtle definition

### Internal Layout
**Padding Structure**:
- Outer padding: 20px (p-5)
- Vertical spacing between elements: 12px (space-y-3)

**Header Section**:
- Flex row with items-center
- Red status dot: 8px diameter circle, #DC2626 fill
- Margin-right of dot: 8px (mr-2)
- Title text immediately adjacent to dot
- Close button: Absolute positioned top-right (top-4, right-4)
- Close button size: 32px × 32px tap target
- Close icon: 20px, gray-600 color

**Message Body**:
- Left-aligned text
- Line height: 1.5
- Max 3 lines before truncation
- Conflict details displayed in structured format

**Action Section**:
- Flex row with justify-between
- "Don't show today" checkbox with label
- Label text: 14px, gray-600
- Checkbox size: 16px

### Interactive States
**Close Button**:
- Default: gray-600, opacity 60%
- Hover: gray-800, opacity 100%
- Rounded background on hover: 8px radius, gray-100

**Checkbox**:
- Border: 2px solid gray-300
- Checked: Red fill (#DC2626) with white checkmark
- Focus ring: 2px offset, red-500/50 opacity

---

## Schedule Management Interface Components

### Schedule Grid
**Structure**:
- 7-column grid for week view (grid-cols-7)
- Time slots in rows with 30-minute increments
- Sticky header row for day labels
- Fixed left column for time labels

**Class Cards**:
- Rounded corners: 8px (rounded-lg)
- Padding: 12px (p-3)
- Elevation: Subtle shadow (0 2px 4px rgba(0,0,0,0.06))
- Instructor name: 14px, semi-bold
- Class time: 12px, gray-600
- Available spots indicator: 12px, badge style

### Navigation Header
**Height**: 64px fixed
**Layout**:
- Flex row with space-between
- Logo/title: 20px, semi-bold
- Primary navigation: Horizontal tabs
- User actions: Right-aligned buttons (Add Class, Filter, Profile)

### Action Buttons
**Primary (Add Class, Confirm)**:
- Height: 40px
- Padding: 12px horizontal, 8px vertical (px-3 py-2)
- Rounded: 8px
- Semi-bold text

**Secondary (Cancel, Filter)**:
- Same dimensions as primary
- Border: 2px solid with transparent background

**Icon Buttons** (Close, Options):
- Square: 40px × 40px
- Rounded: 8px
- Icon size: 20px

### Filter Panel
**Drawer Style**:
- Slides from right edge
- Width: 320px
- Full height
- White background with shadow
- Padding: 24px (p-6)

**Filter Options**:
- Checkbox groups with 16px spacing
- Clear filters link at bottom
- Apply button: Full width, sticky bottom

### Class Detail Modal
**Dimensions**:
- Max width: 600px
- Centered overlay
- Backdrop: Black with 40% opacity
- Modal padding: 32px (p-8)
- Rounded: 16px (rounded-2xl)

**Content Structure**:
- Header: Class name, 24px semi-bold
- Meta row: Instructor, time, location - 14px gray-600
- Divider: 1px gray-200 line with 16px vertical margin
- Description section
- Action buttons row at bottom

---

## Form Elements

### Input Fields
- Height: 44px
- Padding: 12px horizontal (px-3)
- Border: 1px solid gray-300
- Border radius: 8px
- Focus state: 2px border, blue-500 color

### Select Dropdowns
- Match input field styling
- Chevron icon: 16px, right-aligned
- Options list: white background, shadow, 4px border-radius

### Date/Time Pickers
- Calendar popup: 320px width
- White background with shadow
- Selected date: Filled circle, primary color
- Time selector: Scrollable list format

---

## Icons

**Library**: Heroicons (CDN)
**Usage**:
- Navigation: 24px outline icons
- Buttons: 20px outline icons
- Status indicators: 16px solid icons
- Close actions: X mark, 20px

**Key Icons**:
- Calendar: Schedule view toggle
- Plus: Add new class
- Filter: Funnel icon
- Warning: Exclamation circle for conflicts
- User: Profile and instructor info
- Clock: Time display

---

## Conflict Visualization

### Schedule Overlaps
- Overlapping classes: Striped pattern overlay
- Warning indicator: Small red triangle badge on card corner
- Border highlight: 2px red border on conflicting items

### Conflict List View
- Table format with alternating row backgrounds
- Gray-50 for even rows, white for odd
- Conflict severity column with red/yellow/orange badges
- Time clash highlighted with bold text

---

## Responsive Behavior

**Desktop (1024px+)**: Full grid layout, sidebar filters
**Tablet (768-1023px)**: Condensed grid, drawer filters
**Mobile (<768px)**: 
- List view replaces grid
- Notification width: calc(100vw - 32px), max 400px
- Notification position: Centered horizontal, top: 80px
- Single column forms and details

This design system creates a professional, efficient schedule management interface with clear hierarchy, consistent interactions, and focused attention on critical information like conflict warnings.