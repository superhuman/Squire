/*jshint strict:false, undef:false, unused:false */

var keys = {
    8: 'backspace',
    9: 'tab',
    13: 'enter',
    32: 'space',
    33: 'pageup',
    34: 'pagedown',
    37: 'left',
    39: 'right',
    46: 'delete',
    219: '[',
    221: ']'
};

// Ref: http://unixpapa.com/js/key.html
var onKey = function ( event ) {
    var code = event.keyCode,
        key = keys[ code ],
        modifiers = '',
        range = this.getSelection();

    if ( event.defaultPrevented ) {
        return;
    }

    if ( !key ) {
        key = String.fromCharCode( code ).toLowerCase();
        // Only reliable for letters and numbers
        if ( !/^[A-Za-z0-9]$/.test( key ) ) {
            key = '';
        }
    }

    // On keypress, delete and '.' both have event.keyCode 46
    // Must check event.which to differentiate.
    if ( isPresto && event.which === 46 ) {
        key = '.';
    }

    // Function keys
    if ( 111 < code && code < 124 ) {
        key = 'f' + ( code - 111 );
    }

    // We need to apply the backspace/delete handlers regardless of
    // control key modifiers.
    if ( key !== 'backspace' && key !== 'delete' ) {
        if ( event.altKey  ) { modifiers += 'alt-'; }
        if ( event.ctrlKey ) { modifiers += 'ctrl-'; }
        if ( event.metaKey ) { modifiers += 'meta-'; }
    }
    // However, on Windows, shift-delete is apparently "cut" (WTF right?), so
    // we want to let the browser handle shift-delete.
    if ( event.shiftKey ) { modifiers += 'shift-'; }

    key = modifiers + key;

    if ( this._keyHandlers[ key ] ) {
        this._keyHandlers[ key ]( this, event, range );
    } else if ( key.length === 1 && !range.collapsed ) {
        var initialStartOffset = range.startOffset
        // Record undo checkpoint.
        this.saveUndoState( range );
        // Delete the selection
        deleteContentsOfRange( range, this._root );
        this._ensureBottomLine();

        // double clicking a word and typing deletes the space after it
        // caused because a '  ' is automatically cleaned by the HTML to ' '
        // the fix inserts a ZWS in between the spaces => ' \uFEFF '
        // and leaves the ZWS selected so it is replaced by the onKey event
        var textContent = range.startContainer.textContent
        var spliceIndex = range.startOffset
        // if the delete was successful, the startContainer should be the endContainer
        if (range.startContainer === range.endContainer && textContent.charAt( spliceIndex ) === ' ' && textContent.charAt( spliceIndex - 1 ) === ' ') {
          range.startContainer.textContent = textContent.substring( 0, spliceIndex ) + '\uFEFF' + textContent.substring( spliceIndex, textContent.length )
          range.setStart( range.startContainer, initialStartOffset );
          range.setEnd( range.startContainer, initialStartOffset + 1 );
        }
        this.setSelection( range );
        this._updatePath( range, true );
    }
};

var mapKeyTo = function ( method ) {
    return function ( self, event ) {
        event.preventDefault();
        self[ method ]();
    };
};

var mapKeyToFormat = function ( tag, remove ) {
    remove = remove || null;
    return function ( self, event ) {
        event.preventDefault();
        var range = self.getSelection();
        if ( self.hasFormat( tag, null, range ) ) {
            self.changeFormat( null, { tag: tag }, range );
        } else {
            self.changeFormat( { tag: tag }, remove, range );
        }
    };
};

// If you delete the content inside a span with a font styling, Webkit will
// replace it with a <font> tag (!). If you delete all the text inside a
// link in Opera, it won't delete the link. Let's make things consistent. If
// you delete all text inside an inline tag, remove the inline tag.
var afterDelete = function ( self, range ) {
    try {
        if ( !range ) { range = self.getSelection(); }
        var node = range.startContainer,
            parent;
        // Climb the tree from the focus point while we are inside an empty
        // inline element
        if ( node.nodeType === TEXT_NODE ) {
            node = node.parentNode;
        }
        parent = node;
        while ( isInline( parent ) &&
                ( !parent.textContent || parent.textContent === ZWS ) ) {
            node = parent;
            parent = node.parentNode;
        }
        // If focused in empty inline element
        if ( node !== parent ) {
            // Move focus to just before empty inline(s)
            range.setStart( parent,
                indexOf.call( parent.childNodes, node ) );
            range.collapse( true );
            // Remove empty inline(s)
            parent.removeChild( node );
            // Fix cursor in block
            if ( !isBlock( parent ) ) {
                parent = getPreviousBlock( parent, self._root );
            }
            fixCursor( parent, self._root );
            // Move cursor into text node
            moveRangeBoundariesDownTree( range );
        }
        // If you delete the last character in the sole <div> in Chrome,
        // it removes the div and replaces it with just a <br> inside the
        // root. Detach the <br>; the _ensureBottomLine call will insert a new
        // block.
        if ( node === self._root &&
                ( node = node.firstChild ) && node.nodeName === 'BR' ) {
            detach( node );
        }
        self._ensureBottomLine();
        self.setSelection( range );
        self._updatePath( range, true );
    } catch ( error ) {
        self.didError( error );
    }
};

var keyHandlers = {
    enter: function ( self, event, range ) {
        var root = self._root;
        var block, parent, nodeAfterSplit;

        // We handle this ourselves
        event.preventDefault();

        // Save undo checkpoint and add any links in the preceding section.
        // Remove any zws so we don't think there's content in an empty
        // block.
        self._recordUndoState( range );
        addLinks( range.startContainer, root, self );
        self._removeZWS();
        self._getRangeAndRemoveBookmark( range );

        // Selected text is overwritten, therefore delete the contents
        // to collapse selection.
        if ( !range.collapsed ) {
            deleteContentsOfRange( range, root );
        }

        block = getStartBlockOfRange( range, root );

        // If this is a malformed bit of document or in a table;
        // just play it safe and insert a <br>.
        if ( !block || /^T[HD]$/.test( block.nodeName ) ) {
            // If inside an <a>, move focus out
            parent = getNearest( range.endContainer, root, 'A' );
            if ( parent ) {
                parent = parent.parentNode;
                moveRangeBoundariesUpTree( range, parent, parent, root );
                range.collapse( false );
            }
            insertNodeInRange( range, self.createElement( 'BR' ) );
            range.collapse( false );
            self.setSelection( range );
            self._updatePath( range, true );
            return;
        }

        // If in a list, we'll split the LI instead.
        if ( parent = getNearest( block, root, 'LI' )) {
            var child = parent.firstChild
            if ( child && child.tagName == 'PRE' ) {
                block = block;
            } else {
                block = parent;
            }
        }

        if ( isEmptyBlock(block) || block.textContent == " " ) {

            // Break list
            if ( getNearest ( block, root, 'PRE' )) {
                // <div> inside <pre> cannot be empty to be focused, it will contain a space when getting here, make sure we clear it
                block.textContent = block.textContent.replace(" ", "", 1)
                return self.modifyBlocks( decreaseSpecialElementLevel, range );
            }
            else if ( getNearest( block, root, 'UL' ) ||
                    getNearest( block, root, 'OL' ) ) {
                return self.modifyBlocks( decreaseListLevel, range );
            }
            // Break blockquote
            else if ( getNearest( block, root, 'BLOCKQUOTE' ) ) {
                return self.modifyBlocks( removeBlockQuote, range );
            }

        }

        // Otherwise, split at cursor point.
        nodeAfterSplit = splitBlock( self, block,
            range.startContainer, range.startOffset );

        // Clean up any empty inlines if we hit enter at the beginning of the
        // block
        removeZWS( block );
        removeEmptyInlines( block );
        fixCursor( block, root );

        // Focus cursor
        // If there's a <b>/<i> etc. at the beginning of the split
        // make sure we focus inside it.
        while ( nodeAfterSplit.nodeType === ELEMENT_NODE ) {
            var child = nodeAfterSplit.firstChild,
                next;

            // Don't continue links over a block break; unlikely to be the
            // desired outcome.
            if ( nodeAfterSplit.nodeName === 'A' &&
                    ( !nodeAfterSplit.textContent ||
                        nodeAfterSplit.textContent === ZWS ) ) {
                child = self._doc.createTextNode( '' );
                replaceWith( nodeAfterSplit, child );
                nodeAfterSplit = child;
                break;
            }

            while ( child && child.nodeType === TEXT_NODE && !child.data ) {
                next = child.nextSibling;
                if ( !next || next.nodeName === 'BR' ) {
                    break;
                }
                detach( child );
                child = next;
            }

            // 'BR's essentially don't count; they're a browser hack.
            // If you try to select the contents of a 'BR', FF will not let
            // you type anything!
            if ( !child || child.nodeName === 'BR' ||
                    ( child.nodeType === TEXT_NODE && !isPresto ) ) {
                break;
            }
            nodeAfterSplit = child;
        }
        range = self._createRange( nodeAfterSplit, 0 );
        self.setSelection( range );
        self._updatePath( range, true );
    },
    backspace: function ( self, event, range ) {
        var root = self._root;
        self._removeZWS();
        // Record undo checkpoint.
        self.saveUndoState( range );

        // If not collapsed, delete contents
        if ( !range.collapsed ) {
            event.preventDefault();
            deleteContentsOfRange( range, root );
            afterDelete( self, range );
        }

        // If contains an inline element don't delete on first line, instead preventDefault and insert ZWS to keep tags
        // Make sure the cursor is not at the start of line
        else if ( (range.endOffset != 0) &&
            self.hasFormat( 'b', null, range ) ||
            self.hasFormat( 'i', null, range ) ||
            self.hasFormat( 'u', null, range ) ||
            self.hasFormat( 'span', null, range )
        ) {
            var current = getStartBlockOfRange( range, root );
            if ( current && current.firstChild.innerText && getLength( current.firstChild.innerText.replace(/^\uFEFF*/, '') ) == 1 ) {
                event.preventDefault();
                current.firstChild.innerText = '';
                insertNodeInRange( range, self._doc.createTextNode( ZWS ) );
            }
        }

        // If at beginning of block, merge with previous
        else if ( rangeDoesStartAtBlockBoundary( range, root ) ) {
            event.preventDefault();
            var current = getStartBlockOfRange( range, root );
            var previous;

            if ( !current ) {
                return;
            }

            // In case inline data has somehow got between blocks.
            fixContainer( current.parentNode, root );
            // Now get previous block
            previous = getPreviousBlock( current, root );

            // Must not be at the very beginning of the text area.
            if ( previous ) {
                // If not editable, just delete whole block.
                if ( !previous.isContentEditable ) {
                    detach( previous );
                    return;
                }
                // Otherwise merge.
                mergeWithBlock( previous, current, range, root );
                // If deleted line between containers, merge newly adjacent
                // containers.
                current = previous.parentNode;
                while ( current !== root && !current.nextSibling ) {
                    current = current.parentNode;
                }
                if ( current !== root && ( current = current.nextSibling ) ) {
                    mergeContainers( current, root );
                }
                self.setSelection( range );
            }
            // If at very beginning of text area, allow backspace
            // to break lists/blockquote.
            else if ( current ) {
                // Break list
                if ( getNearest ( current, root, 'PRE' )) {
                    return self.modifyBlocks( decreaseSpecialElementLevel, range );
                }
                else if ( getNearest( current, root, 'UL' ) ||
                        getNearest( current, root, 'OL' ) ) {
                    return self.modifyBlocks( decreaseListLevel, range );
                }
                // Break blockquote
                else if ( getNearest( current, root, 'BLOCKQUOTE' ) ) {
                    return self.modifyBlocks( decreaseBlockQuoteLevel, range );
                }
                self.setSelection( range );
                self._updatePath( range, true );
            }
        }
        // Otherwise, leave to browser but check afterwards whether it has
        // left behind an empty inline tag.
        else {
            self.setSelection( range );
            setTimeout( function () { afterDelete( self ); }, 0 );
        }
    },
    'delete': function ( self, event, range ) {
        var root = self._root;
        var current, next, originalRange,
            cursorContainer, cursorOffset, nodeAfterCursor;
        self._removeZWS();
        // Record undo checkpoint.
        self.saveUndoState( range );
        // If not collapsed, delete contents
        if ( !range.collapsed ) {
            event.preventDefault();
            deleteContentsOfRange( range, root );
            afterDelete( self, range );
        }
        else if (
            self.hasFormat( 'b', null, range ) ||
            self.hasFormat( 'i', null, range ) ||
            self.hasFormat( 'u', null, range ) ||
            self.hasFormat( 'span', null, range )
        ) {
            var current = getStartBlockOfRange( range, root );
            if ( current && current.firstChild.innerText && getLength( current.firstChild.innerText.replace(/^\uFEFF*/, '') ) == 1 ) {
                event.preventDefault();
                current.firstChild.innerText = '';
                insertNodeInRange( range, self._doc.createTextNode( ZWS ) );
            }
        }
        // If at end of block, merge next into this block
        else if ( rangeDoesEndAtBlockBoundary( range, root ) ) {
            event.preventDefault();
            current = getStartBlockOfRange( range, root );
            if ( !current ) {
                return;
            }
            // In case inline data has somehow got between blocks.
            fixContainer( current.parentNode, root );
            // Now get next block
            next = getNextBlock( current, root );
            // Must not be at the very end of the text area.
            if ( next ) {
                // If not editable, just delete whole block.
                if ( !next.isContentEditable ) {
                    detach( next );
                    return;
                }
                // Otherwise merge.
                mergeWithBlock( current, next, range, root );
                // If deleted line between containers, merge newly adjacent
                // containers.
                next = current.parentNode;
                while ( next !== root && !next.nextSibling ) {
                    next = next.parentNode;
                }
                if ( next !== root && ( next = next.nextSibling ) ) {
                    mergeContainers( next, root );
                }
                self.setSelection( range );
                self._updatePath( range, true );
            }
        }
        // Otherwise, leave to browser but check afterwards whether it has
        // left behind an empty inline tag.
        else {
            // But first check if the cursor is just before an IMG tag. If so,
            // delete it ourselves, because the browser won't if it is not
            // inline.
            originalRange = range.cloneRange();
            moveRangeBoundariesUpTree( range, root, root, root );
            cursorContainer = range.endContainer;
            cursorOffset = range.endOffset;
            if ( cursorContainer.nodeType === ELEMENT_NODE ) {
                nodeAfterCursor = cursorContainer.childNodes[ cursorOffset ];
                if ( nodeAfterCursor && nodeAfterCursor.nodeName === 'IMG' ) {
                    event.preventDefault();
                    detach( nodeAfterCursor );
                    moveRangeBoundariesDownTree( range );
                    afterDelete( self, range );
                    return;
                }
            }
            self.setSelection( originalRange );
            setTimeout( function () { afterDelete( self ); }, 0 );
        }
    },
    tab: function ( self, event, range ) {
        var root = self._root;
        var node, parent;
        self._removeZWS();
        // If no selection and at start of block
        if ( range.collapsed && rangeDoesStartAtBlockBoundary( range, root ) ) {
            node = getStartBlockOfRange( range, root );
            // Iterate through the block's parents
            while ( parent = node.parentNode ) {
                // If we find a UL or OL (so are in a list, node must be an LI)
                if ( parent.nodeName === 'UL' || parent.nodeName === 'OL' ) {
                    // Then increase the list level
                    event.preventDefault();
                    self.modifyBlocks( increaseListLevel, range );
                    break;
                }
                node = parent;
            }
        }
    },
    'shift-tab': function ( self, event, range ) {
        var root = self._root;
        var node;
        self._removeZWS();
        // If no selection and at start of block
        if ( range.collapsed && rangeDoesStartAtBlockBoundary( range, root ) ) {
            // Break list
            node = range.startContainer;
            if ( getNearest( node, root, 'UL' ) ||
                    getNearest( node, root, 'OL' ) ) {
                event.preventDefault();
                self.modifyBlocks( decreaseListLevel, range );
            }
        }
    },
    space: function ( self, _, range ) {
        var node, parent;
        self._recordUndoState( range );
        addLinks( range.startContainer, self._root, self );
        self._getRangeAndRemoveBookmark( range );

        // If the cursor is at the end of a link (<a>foo|</a>) then move it
        // outside of the link (<a>foo</a>|) so that the space is not part of
        // the link text.
        node = range.endContainer;
        parent = node.parentNode;
        if ( range.collapsed && parent.nodeName === 'A' &&
                !node.nextSibling && range.endOffset === getLength( node ) ) {
            range.setStartAfter( parent );
        }
        // Delete the selection if not collapsed
        else if ( !range.collapsed ) {
            deleteContentsOfRange( range, self._root );
            self._ensureBottomLine();
            self.setSelection( range );
            self._updatePath( range, true );
        }

        self.setSelection( range );
    },
    left: function ( self ) {
        self._removeZWS();
    },
    right: function ( self ) {
        self._removeZWS();
    }
};

// Firefox pre v29 incorrectly handles Cmd-left/Cmd-right on Mac:
// it goes back/forward in history! Override to do the right
// thing.
// https://bugzilla.mozilla.org/show_bug.cgi?id=289384
if ( isMac && isGecko ) {
    keyHandlers[ 'meta-left' ] = function ( self, event ) {
        event.preventDefault();
        var sel = getWindowSelection( self );
        if ( sel && sel.modify ) {
            sel.modify( 'move', 'backward', 'lineboundary' );
        }
    };
    keyHandlers[ 'meta-right' ] = function ( self, event ) {
        event.preventDefault();
        var sel = getWindowSelection( self );
        if ( sel && sel.modify ) {
            sel.modify( 'move', 'forward', 'lineboundary' );
        }
    };
}

// System standard for page up/down on Mac is to just scroll, not move the
// cursor. On Linux/Windows, it should move the cursor, but some browsers don't
// implement this natively. Override to support it.
if ( !isMac ) {
    keyHandlers.pageup = function ( self ) {
        self.moveCursorToStart();
    };
    keyHandlers.pagedown = function ( self ) {
        self.moveCursorToEnd();
    };
}

keyHandlers[ ctrlKey + 'b' ] = mapKeyToFormat( 'B' );
keyHandlers[ ctrlKey + 'i' ] = mapKeyToFormat( 'I' );
keyHandlers[ ctrlKey + 'u' ] = mapKeyToFormat( 'U' );
keyHandlers[ ctrlKey + 'shift-7' ] = mapKeyToFormat( 'S' );
keyHandlers[ ctrlKey + 'shift-5' ] = mapKeyToFormat( 'SUB', { tag: 'SUP' } );
keyHandlers[ ctrlKey + 'shift-6' ] = mapKeyToFormat( 'SUP', { tag: 'SUB' } );
keyHandlers[ ctrlKey + 'shift-8' ] = mapKeyTo( 'makeUnorderedList' );
keyHandlers[ ctrlKey + 'shift-9' ] = mapKeyTo( 'makeOrderedList' );
keyHandlers[ ctrlKey + '[' ] = mapKeyTo( 'decreaseQuoteLevel' );
keyHandlers[ ctrlKey + ']' ] = mapKeyTo( 'increaseQuoteLevel' );
keyHandlers[ ctrlKey + 'y' ] = mapKeyTo( 'redo' );
keyHandlers[ ctrlKey + 'z' ] = mapKeyTo( 'undo' );
keyHandlers[ ctrlKey + 'shift-z' ] = mapKeyTo( 'redo' );
