import type { TurningMode } from '@/types/slides'

export const ANIMATION_DEFAULT_DURATION = 1000
export const ANIMATION_DEFAULT_TRIGGER = 'click'
export const ANIMATION_CLASS_PREFIX = 'animate__'

export const ENTER_ANIMATIONS = [
  {
    type: 'bounce',
    name: 'Bounce',
    children: [
      { name: 'Bounce in', value: 'bounceIn' },
      { name: 'Bounce in from left', value: 'bounceInLeft' },
      { name: 'Bounce in from right', value: 'bounceInRight' },
      { name: 'Bounce in from bottom', value: 'bounceInUp' },
      { name: 'Bounce in from top', value: 'bounceInDown' },
    ],
  },
  {
    type: 'fade',
    name: 'Fade',
    children: [
      { name: 'Fade in', value: 'fadeIn' },
      { name: 'Fade in downward', value: 'fadeInDown' },
      { name: 'Fade in downward, long', value: 'fadeInDownBig' },
      { name: 'Fade in from left', value: 'fadeInLeft' },
      { name: 'Fade in from left, long', value: 'fadeInLeftBig' },
      { name: 'Fade in from right', value: 'fadeInRight' },
      { name: 'Fade in from right, long', value: 'fadeInRightBig' },
      { name: 'Fade in upward', value: 'fadeInUp' },
      { name: 'Fade in upward, long', value: 'fadeInUpBig' },
      { name: 'Fade in from top left', value: 'fadeInTopLeft' },
      { name: 'Fade in from top right', value: 'fadeInTopRight' },
      { name: 'Fade in from bottom left', value: 'fadeInBottomLeft' },
      { name: 'Fade in from bottom right', value: 'fadeInBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: 'Rotate',
    children: [
      { name: 'Rotate in', value: 'rotateIn' },
      { name: 'Rotate in around bottom left', value: 'rotateInDownLeft' },
      { name: 'Rotate in around bottom right', value: 'rotateInDownRight' },
      { name: 'Rotate in around top left', value: 'rotateInUpLeft' },
      { name: 'Rotate in around top right', value: 'rotateInUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: 'Zoom',
    children: [
      { name: 'Zoom in', value: 'zoomIn' },
      { name: 'Zoom in downward', value: 'zoomInDown' },
      { name: 'Zoom in from left', value: 'zoomInLeft' },
      { name: 'Zoom in from right', value: 'zoomInRight' },
      { name: 'Zoom in upward', value: 'zoomInUp' },
    ],
  },
  {
    type: 'slide',
    name: 'Slide in',
    children: [
      { name: 'Slide in downward', value: 'slideInDown' },
      { name: 'Slide in from right', value: 'slideInLeft' },
      { name: 'Slide in from left', value: 'slideInRight' },
      { name: 'Slide in upward', value: 'slideInUp' },
    ],
  },
  {
    type: 'flip',
    name: 'Flip',
    children: [
      { name: 'Flip in on X axis', value: 'flipInX' },
      { name: 'Flip in on Y axis', value: 'flipInY' },
    ],
  },
  {
    type: 'back',
    name: 'Zoom and slide in',
    children: [
      { name: 'Zoom and slide in downward', value: 'backInDown' },
      { name: 'Zoom and slide in from left', value: 'backInLeft' },
      { name: 'Zoom and slide in from right', value: 'backInRight' },
      { name: 'Zoom and slide in upward', value: 'backInUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: 'Fly in',
    children: [
      { name: 'Fly in from right', value: 'lightSpeedInRight' },
      { name: 'Fly in from left', value: 'lightSpeedInLeft' },
    ],
  },
]

export const EXIT_ANIMATIONS = [
  {
    type: 'bounce',
    name: 'Bounce',
    children: [
      { name: 'Bounce out', value: 'bounceOut' },
      { name: 'Bounce out to left', value: 'bounceOutLeft' },
      { name: 'Bounce out to right', value: 'bounceOutRight' },
      { name: 'Bounce out upward', value: 'bounceOutUp' },
      { name: 'Bounce out downward', value: 'bounceOutDown' },
    ],
  },
  {
    type: 'fade',
    name: 'Fade',
    children: [
      { name: 'Fade out', value: 'fadeOut' },
      { name: 'Fade out downward', value: 'fadeOutDown' },
      { name: 'Fade out downward, long', value: 'fadeOutDownBig' },
      { name: 'Fade out to left', value: 'fadeOutLeft' },
      { name: 'Fade out to left, long', value: 'fadeOutLeftBig' },
      { name: 'Fade out to right', value: 'fadeOutRight' },
      { name: 'Fade out to right, long', value: 'fadeOutRightBig' },
      { name: 'Fade out upward', value: 'fadeOutUp' },
      { name: 'Fade out upward, long', value: 'fadeOutUpBig' },
      { name: 'Fade out to top left', value: 'fadeOutTopLeft' },
      { name: 'Fade out to top right', value: 'fadeOutTopRight' },
      { name: 'Fade out to bottom left', value: 'fadeOutBottomLeft' },
      { name: 'Fade out to bottom right', value: 'fadeOutBottomRight' },
    ],
  },
  {
    type: 'rotate',
    name: 'Rotate',
    children: [
      { name: 'Rotate out', value: 'rotateOut' },
      { name: 'Rotate out around bottom left', value: 'rotateOutDownLeft' },
      { name: 'Rotate out around bottom right', value: 'rotateOutDownRight' },
      { name: 'Rotate out around top left', value: 'rotateOutUpLeft' },
      { name: 'Rotate out around top right', value: 'rotateOutUpRight' },
    ],
  },
  {
    type: 'zoom',
    name: 'Zoom',
    children: [
      { name: 'Zoom out', value: 'zoomOut' },
      { name: 'Zoom out downward', value: 'zoomOutDown' },
      { name: 'Zoom out to left', value: 'zoomOutLeft' },
      { name: 'Zoom out to right', value: 'zoomOutRight' },
      { name: 'Zoom out upward', value: 'zoomOutUp' },
    ],
  },
  {
    type: 'slide',
    name: 'Slide out',
    children: [
      { name: 'Slide out downward', value: 'slideOutDown' },
      { name: 'Slide out to left', value: 'slideOutLeft' },
      { name: 'Slide out to right', value: 'slideOutRight' },
      { name: 'Slide out upward', value: 'slideOutUp' },
    ],
  },
  {
    type: 'flip',
    name: 'Flip',
    children: [
      { name: 'Flip out on X axis', value: 'flipOutX' },
      { name: 'Flip out on Y axis', value: 'flipOutY' },
    ],
  },
  {
    type: 'back',
    name: 'Zoom and slide out',
    children: [
      { name: 'Zoom and slide out downward', value: 'backOutDown' },
      { name: 'Zoom and slide out to left', value: 'backOutLeft' },
      { name: 'Zoom and slide out to right', value: 'backOutRight' },
      { name: 'Zoom and slide out upward', value: 'backOutUp' },
    ],
  },
  {
    type: 'lightSpeed',
    name: 'Fly out',
    children: [
      { name: 'Fly out to right', value: 'lightSpeedOutRight' },
      { name: 'Fly out to left', value: 'lightSpeedOutLeft' },
    ],
  },
]

export const ATTENTION_ANIMATIONS = [
  {
    type: 'shake',
    name: 'Shake',
    children: [
      { name: 'Shake sideways', value: 'shakeX' },
      { name: 'Shake up and down', value: 'shakeY' },
      { name: 'Head shake', value: 'headShake' },
      { name: 'Swing', value: 'swing' },
      { name: 'Shake', value: 'wobble' },
      { name: 'Wobble', value: 'tada' },
      { name: 'Jelly', value: 'jello' },
    ],
  },
  {
    type: 'other',
    name: 'Other',
    children: [
      { name: 'Bounce', value: 'bounce' },
      { name: 'Flash', value: 'flash' },
      { name: 'Pulse', value: 'pulse' },
      { name: 'Rubber band', value: 'rubberBand' },
      { name: 'Heartbeat (fast)', value: 'heartBeat' },
    ],
  },
]

interface SlideAnimation {
  label: string
  value: TurningMode
}

export const SLIDE_ANIMATIONS: SlideAnimation[] = [
  { label: 'None', value: 'no' },
  { label: 'Random', value: 'random' },
  { label: 'Push sideways', value: 'slideX' },
  { label: 'Push vertically', value: 'slideY' },
  { label: 'Push sideways (3D)', value: 'slideX3D' },
  { label: 'Push vertically (3D)', value: 'slideY3D' },
  { label: 'Fade', value: 'fade' },
  { label: 'Rotate', value: 'rotate' },
  { label: 'Split vertically', value: 'scaleY' },
  { label: 'Split sideways', value: 'scaleX' },
  { label: 'Zoom in', value: 'scale' },
  { label: 'Zoom out', value: 'scaleReverse' },
]