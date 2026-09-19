<?php
/*
 * No "Permanent login". A console that stays signed in for a month on whatever
 * browser last used it is the wrong default for a database with orders in it;
 * a session here ends when the browser does.
 *
 * The constructor is what enforces it: it runs before Adminer reads the login,
 * and drops the flag from every POST, so ticking the box -- or forging the
 * field -- does nothing. The style only hides a checkbox that no longer works.
 */
class AdminerNoPermanentLogin extends Adminer\Plugin {
    function __construct() {
        if (isset($_POST['auth']) && is_array($_POST['auth'])) unset($_POST['auth']['permanent']);
    }
    function head($dark = null) {
        echo "<style>label:has(input[name='auth[permanent]']){display:none}</style>\n";
    }
}
return new AdminerNoPermanentLogin();
