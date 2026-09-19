<?php
/*
 * One server, and only this one.
 *
 * Without this the login form takes any host:port in its Server field, and
 * Adminer becomes a way to reach anything this container can reach -- the
 * class of bug behind CVE-2021-21311. Pinned, the field is a one-item list and
 * the credentials are only ever sent to the desk's own database.
 */
require_once 'plugins/login-servers.php';

return new AdminerLoginServers([
    'BTC desk (btc_desk)' => ['server' => 'db', 'driver' => 'pgsql'],
]);
