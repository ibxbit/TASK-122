import { type FrameInput, emptyInput } from './runtime';

/* =========================================================================
 * Input Layer — captures mouse, keyboard, wheel and composes a FrameInput
 * snapshot each tick.  The Dear ImGui pattern uses per-frame edge flags
 * (mousePressed / mouseReleased) so widgets don't need to diff themselves.
 * ========================================================================= */

export class InputLayer {
  private mouseX = -1;
  private mouseY = -1;
  private mouseDown = false;
  private mouseWasDown = false;
  private rightPressedEdge = false;
  private wheelAccum = 0;
  private keysPressedBuffer = new Set<string>();
  private textBuffer = '';
  private modifiers = { ctrl: false, alt: false, shift: false, meta: false };

  attach(target: HTMLElement): () => void {
    const onMove  = (e: MouseEvent) => { const r = target.getBoundingClientRect(); this.mouseX = e.clientX - r.left; this.mouseY = e.clientY - r.top; };
    const onDown  = (e: MouseEvent) => {
      if (e.button === 2) { this.rightPressedEdge = true; }
      else                { this.mouseDown = true; }
      target.focus();
    };
    const onUp    = (e: MouseEvent) => { if (e.button !== 2) this.mouseDown = false; };
    const onContextMenu = (e: MouseEvent) => {
      // Suppress the browser's default right-click menu so our ImGui
      // context menu wins the interaction.
      e.preventDefault();
    };
    const onLeave = (_e: MouseEvent) => { this.mouseX = -1; this.mouseY = -1; };
    const onWheel = (e: WheelEvent)  => { this.wheelAccum += e.deltaY; e.preventDefault(); };
    const onKey   = (e: KeyboardEvent) => {
      this.keysPressedBuffer.add(e.code);
      this.keysPressedBuffer.add(e.key);
      this.modifiers = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.textBuffer += e.key;
      }
      // Prevent browser accelerators from swallowing critical keys
      if (['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.modifiers = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    };

    target.addEventListener('mousemove',   onMove);
    target.addEventListener('mousedown',   onDown);
    target.addEventListener('mouseup',     onUp);
    target.addEventListener('mouseleave',  onLeave);
    target.addEventListener('wheel',       onWheel, { passive: false });
    target.addEventListener('keydown',     onKey);
    target.addEventListener('keyup',       onKeyUp);
    target.addEventListener('contextmenu', onContextMenu);

    if (target.tabIndex < 0) target.tabIndex = 0;

    return () => {
      target.removeEventListener('mousemove',   onMove);
      target.removeEventListener('mousedown',   onDown);
      target.removeEventListener('mouseup',     onUp);
      target.removeEventListener('mouseleave',  onLeave);
      target.removeEventListener('wheel',       onWheel);
      target.removeEventListener('keydown',     onKey);
      target.removeEventListener('keyup',       onKeyUp);
      target.removeEventListener('contextmenu', onContextMenu);
    };
  }

  /** Snapshot + reset per-frame edge flags. */
  snapshot(): FrameInput {
    const snap: FrameInput = {
      mouseX:        this.mouseX,
      mouseY:        this.mouseY,
      mouseDown:     this.mouseDown,
      mousePressed:  this.mouseDown && !this.mouseWasDown,
      mouseReleased: !this.mouseDown && this.mouseWasDown,
      rightPressed:  this.rightPressedEdge,
      wheelDelta:    this.wheelAccum,
      keysPressed:   new Set(this.keysPressedBuffer),
      modifiers:     { ...this.modifiers },
      textInput:     this.textBuffer,
    };
    this.mouseWasDown = this.mouseDown;
    this.rightPressedEdge = false;
    this.wheelAccum = 0;
    this.keysPressedBuffer.clear();
    this.textBuffer = '';
    return snap;
  }

  static empty(): FrameInput { return emptyInput(); }
}
