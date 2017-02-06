/**
 * A thread is a running stack context and all the metadata needed.
 * @param {?string} firstBlock First block to execute in the thread.
 * @constructor
 */
var Thread = function (firstBlock) {
    /**
     * ID of top block of the thread
     * @type {!string}
     */
    this.topBlock = firstBlock;

    /**
     * Stack for the thread. When the sequencer enters a control structure,
     * the block is pushed onto the stack so we know where to exit.
     * @type {Array.<string>}
     */
    this.stack = null;

    this.procStack = [];    // stack of proc codes at execution

    /**
     * Stack frames for the thread. Store metadata for the executing blocks.
     * @type {Array.<Object>}
     */
    // this.stackFrames = [];

    /**
     * Status of the thread, one of three states (below)
     * @type {number}
     */
    this.status = 0; /* Thread.STATUS_RUNNING */

    /**
     * Target of this thread.
     * @type {?Target}
     */
    this.target = null;

    /**
     * Whether the thread requests its script to glow during this frame.
     * @type {boolean}
     */
    this.requestScriptGlowInFrame = false;

    /**
     * Which block ID should glow during this frame, if any.
     * @type {?string}
     */
    this.blockGlowInFrame = null;

    /**
     * A timer for when the thread enters warp mode.
     * Substitutes the sequencer's count toward WORK_TIME on a per-thread basis.
     * @type {?Timer}
     */
    this.warpTimer = null;
};

/**
 * Thread status for initialized or running thread.
 * This is the default state for a thread - execution should run normally,
 * stepping from block to block.
 * @const
 */
Thread.STATUS_RUNNING = 0;

/**
 * Threads are in this state when a primitive is waiting on a promise;
 * execution is paused until the promise changes thread status.
 * @const
 */
Thread.STATUS_PROMISE_WAIT = 1;

/**
 * Thread status for yield.
 * @const
 */
Thread.STATUS_YIELD = 2;

/**
 * Thread status for a single-tick yield. This will be cleared when the
 * thread is resumed.
 * @const
 */
Thread.STATUS_YIELD_TICK = 3;

/**
 * Thread status for a finished/done thread.
 * Thread is in this state when there are no more blocks to execute.
 * @const
 */
Thread.STATUS_DONE = 4;

/**
 * Push stack and update stack frames appropriately.
 * @param {string} blockId Block ID to push to stack.
 */
Thread.prototype.pushStack = function (blockId) {
    // this.stack.push(blockId);
    // Push an empty stack frame, if we need one.
    // Might not, if we just popped the stack.
    // if (this.stack.length > this.stackFrames.length) {
        // Copy warp mode from any higher level.
    return this.stack = new Stack(blockId, this.stack);
};

var Stack = function(blockId, parentFrame) {
    this.blockId = blockId;
    // this.block = blockId;   // want to store 'actual' block
    this.parentFrame = parentFrame;
    this.warpMode = parentFrame !== null && parentFrame.warpMode;
    this.reported = {};
    this.params = {};           // Procedure parameters.
    this.executionContext = {}; // A context passed to block implementations.
};

Stack.prototype.waitingReporter = null;
Stack.prototype.procedureCode = null;

/**
 * Pop last block on the stack and its stack frame.
 * @return {string} Block ID popped from the stack.
 */
Thread.prototype.popStack = function () {
    var frame = this.stack;
    if (frame.procedureCode !== null) { // Free up recusive procedure check.
        this.procStack.pop();
    }
    this.stack = frame.parentFrame;
    return frame.blockId;
};

/**
 * Pop last block off the stack and its stack frame.
 * @return {?Object} The new last item on the stack frame.
 */
Thread.prototype.popStackGetFrame = function () {
    var frame = this.stack;
    if (frame.procedureCode !== null) { // Free up recusive procedure check.
        this.procStack.pop();
    }
    return (this.stack = frame.parentFrame);
};

Thread.prototype.stopThisScript = function () {
    var frame = this.stack;
    while (frame !== null) {
        if (frame.procedureCode !== null) {
            this.procStack.pop();
            frame = frame.parentFrame;
            break;
        }
        frame = frame.parentFrame;
    }
    this.stack = frame;

    if (frame === null) {
        // Clean up!
        this.requestScriptGlowInFrame = false;
        this.status = Thread.STATUS_DONE;
    }
};

/**
 * Get top stack item.
 * @return {?string} Block ID on top of stack.
 */
Thread.prototype.peekStack = function () {
    var stack = this.stack;
    return stack !== null ? stack.blockId : null;
};


/**
 * Get top stack frame.
 * @return {?Object} Last stack frame stored on this thread.
 */
Thread.prototype.peekStackFrame = function () {
    return this.stack;
};

/**
 * Push a reported value to the parent of the current stack frame.
 * @param {*} value Reported value to push.
 */
Thread.prototype.pushReportedValue = function (value) {
    var stack = this.stack;
    var parentStackFrame = stack !== null ? stack.parentFrame : null;
    if (parentStackFrame !== null) {
        parentStackFrame.reported[parentStackFrame.waitingReporter] = value;
    }
};

/**
 * Add a parameter to the stack frame.
 * Use when calling a procedure with parameter values.
 * @param {!string} paramName Name of parameter.
 * @param {*} value Value to set for parameter.
 */
Thread.prototype.pushParam = function (paramName, value) {
    // var stackFrame = this.peekStackFrame();
    this.stack.params[paramName] = value;
};

/**
 * Get a parameter at the lowest possible level of the stack.
 * @param {!string} paramName Name of parameter.
 * @return {*} value Value for parameter.
 */
Thread.prototype.getParam = function (paramName) {
    var frame = this.stack;
    while (frame !== null) {
        var param = frame.params[paramName];
        if (param !== undefined) {
            return param;
        }
        frame = frame.parentFrame;
    }
    return null;
};

/**
 * Whether the current execution of a thread is at the top of the stack.
 * @return {Boolean} True if execution is at top of the stack.
 */
Thread.prototype.atStackTop = function () {
    var stack = this.stack;
    return stack !== null && stack.blockId === this.topBlock;
};


/**
 * Switch the thread to the next block at the current level of the stack.
 * For example, this is used in a standard sequence of blocks,
 * where execution proceeds from one block to the next.
 */
Thread.prototype.goToNextBlock = function () {
    var frame = this.stack;
    frame.blockId = this.target.blocks.getNextBlock(frame.blockId);
    frame.isLoop = false;
    // frame.warpMode = warpMode;   // warp mode stays the same when reusing the stack frame.
    frame.reported = {};
    frame.waitingReporter = null;
    frame.params = {};
    frame.executionContext = {};
};

/**
 * Attempt to determine whether a procedure call is recursive,
 * by examining the stack.
 * @param {!string} procedureCode Procedure code of procedure being called.
 * @return {boolean} True if the call appears recursive.
 */
Thread.prototype.isRecursiveCall = function (procedureCode) {

    return procedureCode in this.procStack;

    // var callCount = 5; // Max number of enclosing procedure calls to examine.
    // var frame = this.stack.parentFrame;
    // var targetBlocks = this.target.blocks;
    // while (callCount-- >= 0 && frame !== null) {
    //     var block = targetBlocks.getBlock(frame.blockId);
    //     if (block.opcode === 'procedures_callnoreturn' &&
    //         block.mutation.proccode === procedureCode) {
    //         return true;
    //     }
    //     frame = frame.parentFrame;
    // }
    // return false;
};

module.exports = Thread;
